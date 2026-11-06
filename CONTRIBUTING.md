# Contributing to NSDDSiteSim

## Pull Request Workflow

1. Fork `ORNL/NSDDSiteSim` and create a feature branch from `main`.
2. Validate installer syntax and run the unit test suite before opening a pull request:

```bash
bash -n scripts/install-rpm-only-systemd.sh
python3 -m pytest -q
```

3. Never commit `.env` files, credentials, SSH keys, private runtime state/videos, or internal lab IP addresses (use RFC 5737 `192.0.2.x` documentation addresses in examples).
