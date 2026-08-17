# Deploying to EC2 + Plesk

Target: `rma.xpert.chat` on the existing EC2 (`43.204.145.72`), same server as `agent.xpert.chat`.  
PM2 runs the Next.js standalone app on port **3011**. Plesk nginx proxies `rma.xpert.chat → localhost:3011`.

---

## First-time setup (~10 minutes)

### 1. SSH in

```bash
ssh -i ~/.ssh/xpert_ec2_ads ubuntu@43.204.145.72
```

### 2. Clone the repo

```bash
sudo mkdir -p /opt/rma-ai
sudo chown ubuntu:ubuntu /opt/rma-ai
git clone https://github.com/rmaslunia/rma-ai /opt/rma-ai
```

### 3. Create the secrets file

```bash
sudo mkdir -p /etc/rma-ai
sudo touch /etc/rma-ai/env
sudo chown ubuntu:ubuntu /etc/rma-ai/env
sudo chmod 600 /etc/rma-ai/env
nano /etc/rma-ai/env
```

Paste (fill in real values):

```
ANTHROPIC_API_KEY=sk-ant-...your-rotated-key...
RMA_DB_HOST=mum-db-rma.ct2cw0yswug5.ap-south-1.rds.amazonaws.com
RMA_DB_USER=ranita
RMA_DB_PASS=Ytre^543hgf
RMA_DB_NAME=release4_rma
RMA_AI_DB_HOST=mum-db-rma.ct2cw0yswug5.ap-south-1.rds.amazonaws.com
RMA_AI_DB_USER=ranita
RMA_AI_DB_PASS=Ytre^543hgf
RMA_AI_DB_NAME=rma_ai
ADMIN_PASSWORD=choose-a-strong-shared-password
```

Save and exit (`Ctrl-X Y Enter`).

### 4. Run the first deploy

```bash
bash /opt/rma-ai/scripts/deploy.sh
```

This will: `npm ci` → `npm run build` → standalone static fixup → `pm2 start`.

### 5. Verify the app is running

```bash
pm2 status
curl -s http://127.0.0.1:3011/api/health
```

Should return `{"status":"ok",...}`.

---

## Configure Plesk nginx proxy

In the Plesk panel for the `rma.xpert.chat` subdomain:

1. **Hosting Settings** → set document root to `/opt/rma-ai/public` (or leave default — nginx will bypass it once the proxy is set)
2. **Apache & nginx Settings** → under **Additional nginx directives**, paste:

```nginx
location / {
    proxy_pass         http://127.0.0.1:3011;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection 'upgrade';
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
}
```

3. Click **OK** → Plesk reloads nginx.
4. Open `http://rma.xpert.chat` → should redirect to `/login`.

---

## Enable HTTPS

In the Plesk panel for `rma.xpert.chat`:  
**SSL/TLS Certificates** → **Let's Encrypt** → issue certificate. Done.

---

## Subsequent deploys (manual)

```bash
ssh -i ~/.ssh/xpert_ec2_ads ubuntu@43.204.145.72 \
  'bash /opt/rma-ai/scripts/deploy.sh'
```

Takes ~90s. `pm2 reload --update-env` means zero downtime.

---

## Day-1 sanity check after deploy

```
1. https://rma.xpert.chat/login     — enter ADMIN_PASSWORD
2. https://rma.xpert.chat/api/health — {"status":"ok"}
3. https://rma.xpert.chat/dashboard  — 0 runs (normal — no backtest yet)
4. https://rma.xpert.chat/proposals  — 0 proposals (normal — extractor not run yet)
```

If `/api/health` returns "DB error": check that the RDS security group allows inbound TCP 3306 from `43.204.145.72`.

---

## PM2 useful commands

```bash
pm2 status                          # see all processes
pm2 logs rma-ai --lines 100         # tail logs
pm2 reload ecosystem.config.js --update-env   # reload after env change
pm2 restart rma-ai                  # hard restart
pm2 stop rma-ai                     # stop without removing
```

---

## Cost

- No new server cost — same EC2 instance as `agent.xpert.chat`
- Anthropic Haiku 4.5: backtest + shadow mode ≈ ₹500–₹2000/month at current ad volumes
- RDS: already paid for
