# Ads Operations Integrity

Amazon Ads operations analysis dashboard deployed as a static GitHub Pages site.

## Security

AI provider API keys are **not stored in this public repository**. Configure them from the dashboard's **API 设置** button; keys are kept only in the current browser tab session.

## Deployment

GitHub Actions rebuilds the static `index.html` from the compressed source parts under `.site-src/` and deploys it to GitHub Pages.
