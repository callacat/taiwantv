# Version Management

## Current Version: 1.0.0

## How to Version

- `feat:` → MINOR +1
- `fix:` → PATCH +1
- `feat!:` or with `BREAKING CHANGE` → MAJOR +1

## Commands

```bash
# After commits, tag and release:
git tag v$(cat VERSION)
git push --tags
# GitHub Action will auto-build Docker image
```
