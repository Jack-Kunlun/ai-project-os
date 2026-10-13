"""Isolated fixture-only checks; no production paths, credentials or services."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1]/'deploy/production/ai-project-os-configure-email-auth.py'
spec = importlib.util.spec_from_file_location('email_configuration', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def payload(**changes):
    result = {'schema': helper.SCHEMA, 'accessKeyId': 'testid',
              'accessKeySecret': 'synthetic-secret', 'regionId': 'cn-hangzhou',
              'accountName': 'no-reply@example.invalid'}
    result.update(changes)
    return result


class EmailConfigurationTests(unittest.TestCase):
    def test_raw_configuration_preserves_printable_secret_bytes(self):
        secret = "synthetic-'\"$VALUE\\\\#=tail\\"
        data = helper.parse_payload(json.dumps(payload(accessKeySecret=secret)).encode())
        self.assertIn(('AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET='+secret+'\n').encode(), data)
        self.assertEqual(len(data.splitlines()), 5)
        helper.existing_configuration_valid(data)

    def test_payload_rejects_duplicate_trailing_and_oversized_json(self):
        valid = json.dumps(payload()).encode()
        for data in (b'', b'\xff', valid+b'{}', b'x'*8193,
                     valid[:-1]+b',"schema":"AI_PROJECT_OS_EMAIL_AUTH_CONFIG_V1"}'):
            with self.subTest(data_length=len(data)), self.assertRaises(helper.GateFailure):
                helper.parse_payload(data)

    def test_input_shape_and_injection_rejected_without_secret_in_error(self):
        secret = 'SYNTHETIC_PRIVATE_VALUE'
        invalid = ({'extra': 'x'}, {'schema': 'other'}, {'accessKeyId': 'id\nOTHER=x'},
                   {'accessKeySecret': secret+'\nOTHER=x'}, {'accessKeySecret': ''},
                   {'regionId': 'http://localhost'}, {'accountName': 'a@example.invalid\r\nBcc:x'},
                   {'accountName': 'a..b@example.invalid'}, {'accountName': 'a@-example.invalid'})
        for change in invalid:
            with self.subTest(fields=list(change)), self.assertRaises(helper.GateFailure) as error:
                helper.configuration_bytes(payload(**change))
            self.assertNotIn(secret, str(error.exception))
        for value in (None, [], {}, payload(accessKeyId=1), payload(accountName=None)):
            with self.assertRaises(helper.GateFailure):
                helper.configuration_bytes(value)

    def test_version_floor(self):
        for version in ('2.30.0', 'v2.30.1', '5.5.1', '2.30.0-desktop.1\n'):
            helper.require_compose_version(version)
        for version in ('2.29.9', '2.24.0', '2.30', '', 'version 2.30.0', '2.30.0\n2.31.0'):
            with self.assertRaises(helper.GateFailure):
                helper.require_compose_version(version)

    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='email-config-fixture-')
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        directory.chmod(0o700)
        return directory, directory/'email-auth.env'

    def write(self, directory, destination, data):
        helper.atomic_configuration(directory, destination, data, os.getuid(), os.getgid())

    def test_create_replace_and_unchanged_are_atomic_and_private(self):
        directory, destination = self.fixture()
        first = helper.configuration_bytes(payload())
        second = helper.configuration_bytes(payload(accessKeySecret='rotated-synthetic-secret'))
        self.write(directory, destination, first)
        self.assertEqual(destination.read_bytes(), first)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        before = destination.stat()
        self.write(directory, destination, first)
        self.assertEqual(destination.stat().st_mtime_ns, before.st_mtime_ns)
        self.write(directory, destination, second)
        self.assertEqual(destination.read_bytes(), second)
        self.assertNotEqual(destination.stat().st_ino, before.st_ino)
        self.assertEqual([p.name for p in directory.iterdir()], ['email-auth.env'])

    def test_failed_replace_keeps_old_file_and_cleans_temporary(self):
        directory, destination = self.fixture()
        first = helper.configuration_bytes(payload())
        self.write(directory, destination, first)
        with patch.object(helper.os, 'replace', side_effect=OSError('synthetic failure')):
            with self.assertRaises(OSError):
                self.write(directory, destination, helper.configuration_bytes(payload(accessKeyId='newid')))
        self.assertEqual(destination.read_bytes(), first)
        self.assertEqual([p.name for p in directory.iterdir()], ['email-auth.env'])

    def test_unknown_or_duplicate_existing_config_is_not_overwritten(self):
        for data in (b'UNRELATED=value\n', helper.configuration_bytes(payload())+b'OTHER=x\n',
                     helper.configuration_bytes(payload())+b'AI_PROJECT_OS_EMAIL_AUTH_ENABLED=true\n'):
            directory, destination = self.fixture()
            destination.write_bytes(data)
            destination.chmod(0o600)
            with self.assertRaises(helper.GateFailure):
                self.write(directory, destination, helper.configuration_bytes(payload()))
            self.assertEqual(destination.read_bytes(), data)

    def test_symbolic_link_destination_fails_without_touching_target(self):
        directory, destination = self.fixture()
        target = directory/'target'
        target.write_bytes(b'untouched')
        target.chmod(0o600)
        destination.symlink_to(target)
        with self.assertRaises(helper.GateFailure):
            self.write(directory, destination, helper.configuration_bytes(payload()))
        self.assertEqual(target.read_bytes(), b'untouched')

    def test_hard_link_and_public_existing_file_fail(self):
        for mode, hard_link in ((0o644, False), (0o600, True)):
            directory, destination = self.fixture()
            data = helper.configuration_bytes(payload())
            destination.write_bytes(data)
            destination.chmod(mode)
            if hard_link:
                os.link(destination, directory/'linked')
            with self.assertRaises(helper.GateFailure):
                self.write(directory, destination, data)
            self.assertEqual(destination.read_bytes(), data)

    def test_writable_or_symlinked_parent_fails(self):
        directory, destination = self.fixture()
        directory.chmod(0o777)
        with self.assertRaises(helper.GateFailure):
            self.write(directory, destination, helper.configuration_bytes(payload()))
        directory.chmod(0o700)
        alias = directory/'alias'
        alias.symlink_to(directory, target_is_directory=True)
        with self.assertRaises(helper.GateFailure):
            self.write(alias, alias/'email-auth.env', helper.configuration_bytes(payload()))
        self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
