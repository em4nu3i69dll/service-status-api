package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const ruta = "/api/v1/estado"

type lectura struct {
	Instancia string `json:"instancia"`
	Secuencia int64  `json:"secuencia"`
	Online    bool   `json:"online"`
	Latencia  *int64 `json:"latencia_ms"`
	Usuarios  *int   `json:"usuarios"`
	Capacidad *int   `json:"capacidad"`
}

type sobre struct {
	Datos    string `json:"datos"`
	Etiqueta string `json:"etiqueta"`
}

func llaves(maestra, canal string) ([]byte, []byte, error) {
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(maestra) || !regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`).MatchString(canal) {
		return nil, nil, errors.New("clave o canal inválido")
	}
	base, _ := hex.DecodeString(maestra)
	cifrado, err := hkdf.Key(sha256.New, base, []byte("status-v1:"+canal), "cifrado", 32)
	if err != nil {
		return nil, nil, err
	}
	firma, err := hkdf.Key(sha256.New, base, []byte("status-v1:"+canal), "firma", 32)
	return cifrado, firma, err
}

func contexto(canal, direccion, tiempo, nonce string) string {
	return strings.Join([]string{"status-v1", direccion, ruta, canal, tiempo, nonce}, "\n")
}

func sellar(datos lectura, clave, firma []byte, canal string) ([]byte, http.Header, error) {
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	plano, err := json.Marshal(datos)
	if err != nil {
		return nil, nil, err
	}
	bloque, err := aes.NewCipher(clave)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(bloque)
	if err != nil {
		return nil, nil, err
	}
	tiempo := strconv.FormatInt(time.Now().Unix(), 10)
	n := hex.EncodeToString(nonce)
	adicional := contexto(canal, "POST", tiempo, n)
	cifrado := gcm.Seal(nil, nonce, plano, []byte(adicional))
	cuerpo, err := json.Marshal(sobre{base64.StdEncoding.EncodeToString(cifrado[:len(cifrado)-16]), base64.StdEncoding.EncodeToString(cifrado[len(cifrado)-16:])})
	if err != nil {
		return nil, nil, err
	}
	mac := hmac.New(sha256.New, firma)
	mac.Write([]byte(adicional + "\n" + string(cuerpo)))
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("X-Status-Canal", canal)
	h.Set("X-Status-Tiempo", tiempo)
	h.Set("X-Status-Nonce", n)
	h.Set("X-Status-Firma", hex.EncodeToString(mac.Sum(nil)))
	return cuerpo, h, nil
}

func verificar(res *http.Response, clave, firma []byte, canal, solicitud string, secuencia int64) error {
	cuerpo, err := io.ReadAll(io.LimitReader(res.Body, 4097))
	if err != nil || len(cuerpo) > 4096 {
		return errors.New("respuesta demasiado grande o incompleta")
	}
	tiempo, err := strconv.ParseInt(res.Header.Get("X-Status-Tiempo"), 10, 64)
	diferencia := time.Now().Unix() - tiempo
	if err != nil || diferencia > 90 || diferencia < -15 || res.Header.Get("X-Status-Canal") != canal {
		return errors.New("respuesta no autorizada")
	}
	nonce := res.Header.Get("X-Status-Nonce")
	if !regexp.MustCompile(`^[a-f0-9]{24}$`).MatchString(nonce) {
		return errors.New("nonce inválido")
	}
	adicional := contexto(canal, "RESPUESTA", res.Header.Get("X-Status-Tiempo"), nonce)
	mac := hmac.New(sha256.New, firma)
	mac.Write([]byte(adicional + "\n" + string(cuerpo)))
	f, err := hex.DecodeString(res.Header.Get("X-Status-Firma"))
	if err != nil || !hmac.Equal(mac.Sum(nil), f) {
		return errors.New("firma de respuesta incorrecta")
	}
	var s sobre
	if json.Unmarshal(cuerpo, &s) != nil {
		return errors.New("sobre inválido")
	}
	cifrado, err := base64.StdEncoding.Strict().DecodeString(s.Datos)
	if err != nil {
		return err
	}
	etiqueta, err := base64.StdEncoding.Strict().DecodeString(s.Etiqueta)
	if err != nil || len(etiqueta) != 16 {
		return errors.New("etiqueta inválida")
	}
	bloque, err := aes.NewCipher(clave)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(bloque)
	if err != nil {
		return err
	}
	n, _ := hex.DecodeString(nonce)
	plano, err := gcm.Open(nil, n, append(cifrado, etiqueta...), []byte(adicional))
	if err != nil {
		return err
	}
	var acuse struct {
		Aceptado  bool   `json:"aceptado"`
		Solicitud string `json:"solicitud"`
		Secuencia int64  `json:"secuencia"`
	}
	if json.Unmarshal(plano, &acuse) != nil || !acuse.Aceptado || acuse.Solicitud != solicitud || acuse.Secuencia != secuencia || res.StatusCode != 200 {
		return errors.New("lectura rechazada")
	}
	return nil
}

func ejecutar() error {
	destino := flag.String("api", "https://localhost:3444", "URL de la ingesta o del túnel")
	objetivo := flag.String("objetivo", "", "URL HTTP/HTTPS del servicio que se comprueba")
	canal := flag.String("canal", "web", "Canal configurado en la API")
	archivo := flag.String("clave", "local/secretos/web.key", "Archivo con la clave del canal")
	ca := flag.String("ca", "", "CA privada del origen; vacío para certificados públicos")
	nombreTLS := flag.String("nombre-tls", "", "Nombre del certificado del origen")
	intervalo := flag.Duration("intervalo", 0, "Intervalo entre lecturas; 0 envía una sola")
	usuarios := flag.Int("usuarios", -1, "Usuarios actuales, si el emisor dispone del dato")
	capacidad := flag.Int("capacidad", -1, "Capacidad del servicio")
	flag.Parse()
	u, err := url.Parse(*destino)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("la API requiere una URL base HTTPS")
	}
	o, err := url.Parse(*objetivo)
	if err != nil || (o.Scheme != "http" && o.Scheme != "https") || o.Hostname() == "" || o.User != nil {
		return errors.New("indicá -objetivo con una URL HTTP o HTTPS")
	}
	if *intervalo < 0 || (*intervalo > 0 && *intervalo < 5*time.Second) {
		return errors.New("el intervalo mínimo es 5s")
	}
	if (*usuarios < 0) != (*capacidad < 0) || *usuarios > *capacidad || *usuarios > 1000000 || *capacidad > 1000000 {
		return errors.New("usuarios y capacidad inválidos")
	}
	maestra, err := os.ReadFile(*archivo)
	if err != nil {
		return errors.New("no se pudo leer la clave del canal")
	}
	clave, firma, err := llaves(strings.TrimSpace(string(maestra)), *canal)
	if err != nil {
		return err
	}
	config := &tls.Config{MinVersion: tls.VersionTLS13, ServerName: *nombreTLS}
	if *ca != "" {
		pem, err := os.ReadFile(*ca)
		if err != nil {
			return err
		}
		config.RootCAs = x509.NewCertPool()
		if !config.RootCAs.AppendCertsFromPEM(pem) {
			return errors.New("CA inválida")
		}
	}
	cliente := &http.Client{Timeout: 12 * time.Second, Transport: &http.Transport{TLSClientConfig: config}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	sonda := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	id := make([]byte, 12)
	if _, err := rand.Read(id); err != nil {
		return err
	}
	instancia := hex.EncodeToString(id)
	parar := make(chan os.Signal, 1)
	signal.Notify(parar, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(parar)
	for secuencia := int64(1); ; secuencia++ {
		inicio := time.Now()
		res, err := sonda.Get(*objetivo)
		datos := lectura{Instancia: instancia, Secuencia: secuencia}
		if err == nil {
			datos.Online = res.StatusCode >= 200 && res.StatusCode < 400
			ms := time.Since(inicio).Milliseconds()
			datos.Latencia = &ms
			res.Body.Close()
		}
		if *usuarios >= 0 {
			datos.Usuarios = usuarios
			datos.Capacidad = capacidad
		}
		cuerpo, cabeceras, err := sellar(datos, clave, firma, *canal)
		if err != nil {
			return err
		}
		req, err := http.NewRequest(http.MethodPost, strings.TrimRight(*destino, "/")+ruta, bytes.NewReader(cuerpo))
		if err != nil {
			return err
		}
		req.Header = cabeceras
		respuesta, err := cliente.Do(req)
		if err == nil {
			err = verificar(respuesta, clave, firma, *canal, cabeceras.Get("X-Status-Nonce"), secuencia)
			respuesta.Body.Close()
		}
		if err != nil {
			if *intervalo == 0 {
				return errors.New("no se pudo confirmar la lectura: " + err.Error())
			}
			fmt.Fprintln(os.Stderr, "No se confirmó la lectura; se reintentará")
		} else {
			fmt.Printf("Canal %s: lectura %d confirmada, online=%t\n", *canal, secuencia, datos.Online)
		}
		if *intervalo == 0 {
			return nil
		}
		select {
		case <-parar:
			return nil
		case <-time.After(*intervalo):
		}
	}
}

func main() {
	if err := ejecutar(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
