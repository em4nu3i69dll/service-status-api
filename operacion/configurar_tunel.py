import argparse
import json
from pathlib import Path
import re
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--id', required=True)
parser.add_argument('--dominio', required=True)
parser.add_argument('--destino', type=Path, default=Path('local/cloudflared.json'))
args = parser.parse_args()
try:
    tunel = str(uuid.UUID(args.id))
except ValueError:
    parser.error('ID de túnel inválido')
if not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', args.dominio) or len(args.dominio) > 253:
    parser.error('Dominio inválido')
if args.destino.exists():
    parser.error('El archivo ya existe; no se reemplaza su configuración')
config = {
    'tunnel': tunel, 'credentials-file': '/run/secrets/tunel.json',
    'ingress': [
        {'hostname': args.dominio, 'path': '^/api/v1/estado$', 'service': 'https://api:3444',
         'originRequest': {'originServerName': 'status-api', 'caPool': '/run/secrets/ca.crt', 'noTLSVerify': False, 'connectTimeout': '5s', 'tlsTimeout': '5s'}},
        {'service': 'http_status:404'}
    ]
}
args.destino.parent.mkdir(parents=True, exist_ok=True)
args.destino.write_text(json.dumps(config, indent=2), encoding='utf-8')
print('Ruta de ingesta creada. La lectura mTLS queda fuera del túnel.')
