# documentation
Yarilo documentation site (doc.yarilomail.org)

## Serving

The `Deploy docs` workflow builds every version into the `gh-pages` branch. The cluster serves that branch: `helm/` is the chart, `argocd-app.yaml` its ArgoCD application (namespace `yarilomail`, values `helm_values/values-prod.yaml`).

- A sidecar (`alpine:3.24` with git) pulls `gh-pages` every `site.pullIntervalSeconds` (60) into `/site/<commit>` and points `/site/current` at it; nginx serves `/site/current`. A merge shows within a minute, with no image and no rollout.
- nginx: `dir` goes to `dir/` and an extensionless page to its `.html` form, both by relative 301; a missing page is the root `404.html` with status 404; `assets/` of every version are cached for a year; the pod is ready once a checkout is in place (`/healthz`).
- The site is behind Cloudflare. The Ingress takes traffic from Cloudflare's ranges only, with a Let's Encrypt certificate (`letsencrypt-prod`). The Ingress carries the label `cloudflare-whitelist: "true"`, so the cluster's one cf-whitelist CronJob rewrites that list from api.cloudflare.com every 6 hours; `cloudflareWhitelist.ipRanges` is only the starting list, and ArgoCD ignores the annotation, so it does not put it back.
- Logs carry the client's address: nginx takes `CF-Connecting-IP` from `realIp.trustedProxies` only (the pod network, where the ingress controller runs), so a request from anywhere else logs its own peer address. The ingress controller's log already uses `CF-Connecting-IP`.
