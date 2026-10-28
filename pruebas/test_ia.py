import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('analizar', Path(__file__).resolve().parents[1] / 'ia/analizar.py')
modulo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(modulo)


class Informes(unittest.TestCase):
    def test_solo_canales_existentes(self):
        valido = {'resumen': 'Sin lecturas recientes.', 'observaciones': [{'canal': 'web', 'detalle': 'Lectura vencida.', 'prioridad': 'media'}]}
        self.assertEqual(modulo.validar_informe(valido, ['web']), valido)
        valido['observaciones'][0]['canal'] = 'inventado'
        with self.assertRaises(ValueError):
            modulo.validar_informe(valido, ['web'])

    def test_sin_campos_de_acciones_ni_texto_suelto(self):
        for valor in ['todo bien', {'resumen': 'OK', 'observaciones': [], 'ejecutar': 'rm'}, {'resumen': '', 'observaciones': []}]:
            with self.subTest(valor=valor), self.assertRaises(ValueError):
                modulo.validar_informe(valor, ['web'])

    def test_no_acepta_http_remoto(self):
        with self.assertRaises(ValueError):
            modulo.analizar('https://localhost:3443', Path('.'), 'http://modelo.example.com', 'modelo', Path('no-se-crea'))

    def test_informe_incompleto_no_sustituye_el_anterior(self):
        with tempfile.TemporaryDirectory() as carpeta:
            p = Path(carpeta) / 'informe.json'
            p.write_text('anterior')
            with patch.object(modulo.ssl, 'create_default_context'), patch.object(modulo, 'consultar', side_effect=[{'canales': [{'canal': 'web', 'estado': 'online'}]}, {'done': True, 'done_reason': 'length', 'message': {'content': '{}'}}]):
                with self.assertRaises(ValueError):
                    modulo.analizar('https://localhost:3443', Path('.'), 'http://localhost:11434', 'modelo', p)
            self.assertEqual(p.read_text(), 'anterior')

    def test_informe_con_evidencia_y_revision(self):
        with tempfile.TemporaryDirectory() as carpeta:
            p = Path(carpeta) / 'informe.json'
            estado = {'canales': [{'canal': 'web', 'estado': 'online', 'online': True}]}
            texto = {'resumen': 'Hay una lectura vigente.', 'observaciones': [{'canal': 'web', 'detalle': 'Online.', 'prioridad': 'alta'}]}
            with patch.object(modulo.ssl, 'create_default_context'), patch.object(modulo, 'consultar', side_effect=[estado, {'done': True, 'message': {'content': json.dumps(texto)}}]):
                modulo.analizar('https://localhost:3443', Path('.'), 'http://localhost:11434', 'modelo', p)
            resultado = json.loads(p.read_text())
            self.assertTrue(resultado['requiere_revision'])
            self.assertEqual(resultado['evidencia'], estado)
            self.assertEqual(resultado['informe']['observaciones'][0]['prioridad'], 'baja')

    def test_sin_lecturas_no_se_pide_una_opinion_al_modelo(self):
        with tempfile.TemporaryDirectory() as carpeta:
            estado = {'canales': [{'canal': 'juego', 'estado': 'sin_datos', 'online': None}]}
            with patch.object(modulo.ssl, 'create_default_context'), patch.object(modulo, 'consultar', return_value=estado) as consulta:
                resultado = modulo.analizar('https://localhost:3443', Path('.'), 'http://localhost:11434', 'modelo', Path(carpeta) / 'informe.json')
            self.assertEqual(consulta.call_count, 1)
            self.assertIsNone(resultado['modelo'])
            self.assertEqual(resultado['canales_sin_lectura'][0]['estado'], 'sin_datos')


if __name__ == '__main__':
    unittest.main()
