"""Read-only CI preflight of the real Workflow credential transport."""
import importlib.util
import os
from pathlib import Path
import sys


def main():
    try:
        path = Path(__file__).resolve().parents[1] / 'deploy/production/ai-project-os-release-stable.py'
        spec = importlib.util.spec_from_file_location('release_credentials', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        credentials = module.read_release_credentials(sys.stdin)
        if credentials['runId'] != int(os.environ['GITHUB_RUN_ID']):
            raise ValueError('run mismatch')
    except Exception:
        # Never log the exception, input, or token, even if parsing fails.
        print('CI_RELEASE_CREDENTIALS_TRANSPORT_INVALID', file=sys.stderr)
        return 1
    print('CI_RELEASE_CREDENTIALS_TRANSPORT_OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
