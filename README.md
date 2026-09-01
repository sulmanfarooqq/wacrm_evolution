# WhatsApp CRM + Evolution API

A business-oriented **WhatsApp CRM and AI automation platform** combining a Next.js/Supabase CRM with a self-hosted Evolution API integration and Gemini-powered assistance.

## Live Demo

**[Open the deployed application](https://wacrm-evolution.vercel.app)**

## Highlights

- WhatsApp conversation management
- CRM-oriented customer workflows
- Evolution API integration
- AI-assisted automated replies with Gemini
- Supabase-backed application data
- Authentication and application-level access control
- Migration/runbook documentation for deployment

## Architecture

```text
WhatsApp
   ↓
Evolution API
   ↓
CRM / Automation Layer
   ├── Next.js
   ├── Supabase
   └── Gemini AI
```

## Repository Structure

```text
├── wacrm/                    # Main application
│   ├── source
│   ├── Supabase migrations
│   └── tests
└── docs/                     # Setup and migration documentation
```

## Documentation

Start with the deployment and setup runbook:

```text
docs/setup-runbook.md
```

For Vercel deployment details:

```text
wacrm/DEPLOY_VERCEL.md
```

## Security

Keep Supabase credentials, Evolution API credentials, Gemini keys, and other private configuration in environment variables. Never commit production secrets.

## Author

**Muhammad Suliman** — Software Engineer focused on backend systems, AI automation, APIs, and business software.

[GitHub](https://github.com/sulmanfarooqq) · [LinkedIn](https://www.linkedin.com/in/sulmanfarooqq/) · [Portfolio](https://sulmanfarooq.netlify.app) · [FlowVello](https://flowvello.com)
