# Authelia

Single Sign-On (SSO) authentication provider for homelab services.

## Features

- SSO across all protected services
- 2FA support (TOTP, WebAuthn, Duo)
- User management with multiple factors
- Access rules based on IP, time, groups
- Session management with Redis backend

## Access

Web UI: `https://auth.${DOMAIN}`

## Configuration

User database in `servers/home/configs/authelia/users.yml`:

```yaml
users:
  spy4x:
    password: <bcrypt hash>
    email: admin@antonshubin.com
    groups:
      - admin
```

Rules in `servers/home/configs/authelia/configuration.yml` define which services require auth and what factors are needed.

## Integration

Services use `middlewares=authelia@file` in Traefik labels to require SSO.

## Resources

- [Authelia Documentation](https://www.authelia.com/docs/)
