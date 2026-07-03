# Plausible

Privacy-friendly, lightweight web analytics platform.

## Features

- Cookie-free analytics (no GDPR banner needed)
- Pageviews, visitors, bounce rate, visit duration
- Campaign tracking (UTM params)
- Goal/revenue tracking
- Real-time dashboard
- Privacy-focused by design

## Access

Web UI: `https://analytics.${DOMAIN}`

## Architecture

| Component      | Role                                         |
| -------------- | -------------------------------------------- |
| **Plausible**  | Web app and query layer (Elixir)             |
| **PostgreSQL** | Metadata and configuration                   |
| **ClickHouse** | Columnar event storage for analytics queries |

Registration disabled — admin creates accounts.

## Resources

- [Plausible Documentation](https://plausible.io/docs)
- [Plausible GitHub](https://github.com/plausible/analytics)
