from perchtools.run import redact, run


def test_redact_masks_every_secret():
    assert redact("op read x --key abc123 --pw s3cr3t", ["abc123", "s3cr3t"]) == "op read x --key *** --pw ***"


def test_redact_ignores_empty_secret():
    assert redact("plain", [""]) == "plain"


def test_run_logs_redacted_command(capsys):
    result = run(["echo", "token-xyz"], secrets=["token-xyz"], capture=True)
    assert result.stdout.strip() == "token-xyz"
    assert "token-xyz" not in capsys.readouterr().err


def test_run_logs_command(capsys):
    run(["true"])
    assert "$ true" in capsys.readouterr().err


def test_run_raises_on_failure():
    import subprocess

    import pytest

    with pytest.raises(subprocess.CalledProcessError):
        run(["false"])


def test_run_check_false_returns_code():
    assert run(["false"], check=False).returncode == 1
