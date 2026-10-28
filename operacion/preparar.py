import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess


def preparar(destino, canales):
    openssl = os.environ.get('OPENSSL') or shutil.which('openssl')
    if not openssl:
        raise ValueError('Instalá OpenSSL o definí OPENSSL con su ruta')
    if destino.exists():
        raise ValueError('El directorio ya existe; no se reemplazan claves ni datos')
    destino.mkdir(parents=True, mode=0o700)
    carpeta = destino / 'secretos'
    carpeta.mkdir(mode=0o700)
    (destino / 'datos').mkdir(mode=0o700)
    (destino / 'informes').mkdir(mode=0o700)

    def ejecutar(*args):
        subprocess.run([openssl, *args], cwd=carpeta, check=True, capture_output=True)

    ejecutar('req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '365', '-subj', '/CN=Status Local CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
    for nombre in ['servidor', 'monitor', 'ia', 'salud']:
        cn = 'status-api' if nombre == 'servidor' else nombre
        extension = carpeta / (nombre + '.ext')
        contenido = 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
        contenido += 'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:status-api,DNS:api,DNS:localhost,IP:127.0.0.1\n' if nombre == 'servidor' else 'extendedKeyUsage=clientAuth\n'
        extension.write_text(contenido, encoding='utf-8')
        ejecutar('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', nombre + '.key', '-out', nombre + '.csr', '-subj', '/CN=' + cn)
        ejecutar('x509', '-req', '-in', nombre + '.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', '0x' + secrets.token_hex(16), '-out', nombre + '.crt', '-days', '90', '-extfile', extension.name)
        extension.unlink()
        (carpeta / (nombre + '.csr')).unlink()
    shutil.copyfile(carpeta / 'ca.crt', carpeta / 'clientes-ca.crt')
    claves = {canal: secrets.token_hex(32) for canal in canales}
    (carpeta / 'canales.json').write_text(json.dumps(claves), encoding='utf-8')
    for canal, clave in claves.items():
        (carpeta / (canal + '.key')).write_text(clave, encoding='ascii')
    for archivo in carpeta.iterdir():
        archivo.chmod(0o600 if archivo.suffix == '.key' or archivo.name == 'canales.json' else 0o644)
    print('Certificados y claves creados. No publiques el directorio local.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--destino', type=Path, default=Path('local'))
    parser.add_argument('--canales', nargs='+', default=['web', 'juego'])
    args = parser.parse_args()
    import re
    if not 1 <= len(args.canales) <= 32 or any(not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', c) for c in args.canales) or len(set(args.canales)) != len(args.canales):
        parser.error('Indicá entre 1 y 32 canales únicos: letras minúsculas, números y guiones')
    try:
        preparar(args.destino, args.canales)
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + '\n')
