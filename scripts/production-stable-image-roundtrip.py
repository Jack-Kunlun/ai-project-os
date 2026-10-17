"""Verify published artifacts against the exact images already tested in CI."""
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys


def docker(*args):
    result = subprocess.run(['docker', *args], text=True, capture_output=True, timeout=1800)
    if result.returncode != 0:
        raise RuntimeError('CI_IMAGE_ROUNDTRIP_COMMAND_FAILED')
    return result.stdout.strip()


def main():
    path = Path(__file__).resolve().parents[1] / 'deploy/production/ai-project-os-release-stable.py'
    spec = importlib.util.spec_from_file_location('release_images', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    local = json.loads(Path(sys.argv[1]).read_text(), object_pairs_hook=module._unique_json_object)
    published = module.validate_image_manifest(
        json.loads(Path(sys.argv[2]).read_text(), object_pairs_hook=module._unique_json_object),
        os.environ['GITHUB_SHA'], os.environ['APP_VERSION'], int(os.environ['GITHUB_RUN_ID']))
    module.require(set(local) == set(published) and all(local[key] == published[key]
                   for key in ('schema', 'revision', 'version', 'runId'))
                   and isinstance(local['images'], dict)
                   and set(local['images']) == set(published['images']), 'CI_LOCAL_IMAGE_MANIFEST_INVALID')
    for service in ('app', 'worker', 'migrate'):
        local_record = local['images'][service]
        module.require(isinstance(local_record, dict) and set(local_record) == {'ref', 'id'}
                       and local_record['ref'] == 'ai-project-os-ci/' + service + ':' + published['revision']
                       and re.fullmatch(r'sha256:[a-f0-9]{64}', local_record.get('id', '')) is not None,
                       'CI_LOCAL_IMAGE_MANIFEST_INVALID')
        before = json.loads(docker('image', 'inspect', local_record['id']))[0]
        record = published['images'][service]
        docker('pull', '--platform', 'linux/amd64', record['ref'])
        after = json.loads(docker('image', 'inspect', record['ref']))[0]
        runtime_id = module.validate_pulled_image(after, record, published['version'], published['revision'])
        module.require(before.get('RootFS', {}).get('Layers')
                       and before['RootFS'] == after.get('RootFS')
                       and before.get('Config') == after.get('Config')
                       and before.get('Os') == after.get('Os')
                       and before.get('Architecture') == after.get('Architecture'),
                       'CI_IMAGE_ROUNDTRIP_CONTENT_MISMATCH')
        owner = secrets.token_hex(12)
        name = 'ai-project-os-image-proof-' + owner
        identifier = docker('create', '--platform', 'linux/amd64', '--name', name,
                            '--label', 'ai-project-os.ci-image-proof=' + owner,
                            '--entrypoint', '/bin/true', runtime_id)
        module.require(re.fullmatch(r'[a-f0-9]{64}', identifier) is not None, 'CI_IMAGE_PROOF_ID_INVALID')
        try:
            info = json.loads(docker('inspect', identifier))[0]
            owned = (info.get('Id') == identifier and info.get('Name') == '/' + name
                     and info.get('Config', {}).get('Labels', {}).get('ai-project-os.ci-image-proof') == owner)
            module.require(owned, 'CI_IMAGE_PROOF_OWNERSHIP_INVALID')
            module.require(info.get('Image') == runtime_id and not info.get('State', {}).get('Running'),
                           'CI_IMAGE_PROOF_RUNTIME_ID_MISMATCH')
        finally:
            # This exact ID was returned by our successful unique-name create.
            # Never use force or remove a name/reference supplied by a caller.
            docker('rm', identifier)
        print('CI_IMAGE_ROUNDTRIP_OK service=' + service + ' runtime_id=' + runtime_id, flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(code if re.fullmatch(r'(?:STABLE_|CI_)[A-Z_]+', code) else 'CI_IMAGE_ROUNDTRIP_INVALID',
              file=sys.stderr)
        sys.exit(1)
