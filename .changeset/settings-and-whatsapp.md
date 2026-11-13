---
'@otwdesign/plugin-otp': minor
---

A settings page that shows only what applies, a custom HTTP request for any SMS service, and
WhatsApp. It needs OTW CMS 1.8.

- **Roles that must use a code** are ticked from the site's own roles, plugins' included. A
  list saved as text by 1.0 is read as it was.
- **A provider's settings show once it's chosen**, and a channel's section once the channel is
  ticked. Twilio's account shows for whichever of text messages and WhatsApp uses it.
- **The HTTP request can be your service's own**: `POST` or `GET`, a bearer token or custom
  headers (as many rows as it needs, a value `env:NAME` read from the environment), and a body
  that is JSON, a form, or your own template with `{{to}}` and `{{text}}`, escaped for its
  content type.
- **WhatsApp**: a new way people set up with their number, sent as an approved authentication
  template through Meta's WhatsApp Cloud API or Twilio, or a provider added to the new
  `otp.whatsapp` registry.
- **OTP › Status** has a test for each of text messages and WhatsApp, linked from Settings.

Changed: **Send text messages through** no longer has "Automatic". Choose Twilio, the HTTP
request, or "A provider another plugin adds"; a site that had saved Automatic now uses Twilio
until another is chosen.
