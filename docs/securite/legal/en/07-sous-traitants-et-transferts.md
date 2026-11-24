# Processors and Data Transfers

*Version 2026-11-16. List based on the product configuration; the contracts and regions marked [TO COMPLETE] must be confirmed with each provider.*

| Provider | Role | Data concerned | Processing location | Transfer safeguards |
|---|---|---|---|---|
| **Render** | Hosting of the application and API | All data in transit and in memory; technical logs | Region chosen in the deployment: [TO COMPLETE: Frankfurt, Germany according to `render.yaml` — to be confirmed]; US company | [TO COMPLETE] |
| **Neon** | PostgreSQL database | All stored data | [TO COMPLETE: database region, e.g. EU-Central/Frankfurt] | [TO COMPLETE] |
| **Vercel** | Site hosting, `/api` relay to the server | Pages, requests (IP addresses, headers) | Global network; US company | [TO COMPLETE] |
| **AI provider** (Anthropic by default; any OpenAI-compatible service can be configured) | Generation of the assistant's responses | User messages, summarised context of the organisation, attachments submitted | United States [TO COMPLETE: depending on the selected provider] | [TO COMPLETE]; use for training: [TO COMPLETE: provider's condition] |
| **Voice provider** (OpenAI-compatible service, optional) | Transcription and synthesis of voice messages | Audio files | [TO COMPLETE] | [TO COMPLETE] |
| **Brevo** (or configured SMTP server) | Sending e-mails (verification codes, reset, alerts, invoices) | E-mail address, message content | France/EU [TO COMPLETE] | [TO COMPLETE] |
| **Meta** (WhatsApp Business Platform, Messenger, Instagram) | Messaging with the organisation's customers (official API) | Numbers, messages, media | United States/Ireland | [TO COMPLETE] |
| **WhatsApp (QR code link)** | Same use, via an unofficial protocol | Same | Same | See WhatsApp's terms; risk of number restriction |
| **Campay** | Mobile Money payments (MTN, Orange) | Telephone number, amount, reference | Cameroon | [TO COMPLETE] |
| **MTN / Orange operators** | Execution of the payment | Number, amount | Cameroon | — |
| **Google Fonts** (if fonts are not hosted locally) | Display of fonts | Visitor's IP address | United States | [TO COMPLETE: host the fonts to remove this transfer] |

**Services chosen by the organisation (not MABAH processors):** tools linked by webhook or API key (Zapier, Make, n8n, own server). The organisation is responsible for them.

**Changes:** any addition or replacement is announced in the application with [TO COMPLETE: 30] days' notice.

**Principles applied to transfers:** minimisation (AI context limited by role), encryption in transit (HTTPS, SSL connection to the database), isolation by organisation, no sale of data.
