<!-- converted from BlossomTask_Deployment_Guide.docx -->

🌸 BlossomTask
Funeral Order Automation Pipeline
Server Deployment — Complete Guide & Status Report

# 1. Project Overview — BlossomTask क्या है?
BlossomTask एक production-ready automation pipeline है जो funeral orders को end-to-end process करती है। यह system एक React dashboard के साथ आता है जिसे browser में open करके पूरा pipeline control किया जा सकता है।
Pipeline का काम:
- CRM से open tasks fetch करना (GetTask.py)
- Order details enrich करना (GetOrderInquiry.py)
- Perplexity AI से obituary/funeral data search करना (Funeral_Finder.py)
- Data CRM में upload करना (Updater.py)
- Tasks close करना (ClosingTask.py)
Tech Stack:

# 2. Server Analysis — क्या मिला?
Server पर detailed analysis के बाद यह information मिली:
## 2.1 Server Specifications





## 2.2 Server पर क्या है / क्या नहीं
## 2.3 Project Files Status
Project files ALREADY server par hai — double work nahi karna!





## 2.4 Nginx — Important Discovery
Server par Nginx Cloudways manage karta hai. Humara user (master_wrkcghydas) Nginx config files read nahi kar sakta (no sudo). Yeh ek challenge hai.
Solutions:
- Option A (Recommended): Cloudways Dashboard se Nginx vhost configure karo — browser se possible hai
- Option B: Node.js backend khud hi static files serve kare (dist/ folder) — Nginx bypass
- Option C: Dono combine karo — sabse reliable approach

# 3. Deployment Architecture — Kaise Kaam Karega?
Server par yeh structure hogi jab deployment complete hogi:
Request Flow:
User Browser
|
v
https://phpstack-1335521-6323887.cloudwaysapps.com/
|
v
Cloudways Nginx (port 80/443) — SSL handled automatically
|
+——> /api/*  ——proxy——> Node.js Backend (port 8787)
|                            |
|                            +——> Python Scripts (on demand)
|                            +——> CRM API (external)
|                            +——> Perplexity AI (external)
|
+——> /*  ——proxy——> Node.js serves React dist/ files
(index.html for all routes)
PM2 Role:
- PM2 = Process Manager — Node.js ko 24/7 alive rakhta hai
- Server restart hone par automatically start ho jata hai
- Crash hone par automatic restart karta hai
- Logs manage karta hai

# 4. Key Challenges & Solutions


# 5. Complete Deployment Steps — A to Z
Yeh steps SSH terminal mein run karne hain. Ek ek step complete karo, output check karo, aur phir agle step par jao.
## 5.1 Server Connect Karo

## 5.2 Project Directory Mein Jao
cd ~/public_html
ls  # BlossomTask files dikhni chahiye
## 5.3 PM2 Install Karo (bina sudo ke)
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
npm install -g pm2
pm2 --version  # version number aana chahiye
## 5.4 Backend Ko Static Files Serve Karne Ke Liye Update Karo
Yeh command server.js mein React frontend serving add karta hai — ek baar hi karna hai:
cd ~/public_html
cp backend/server.js backend/server.js.backup

python3 - << 'PYEOF'
with open('backend/server.js', 'r') as f:
content = f.read()

static_code = '''
import { fileURLToPath as _fup } from "node:url";
const _sd = path.dirname(_fup(import.meta.url));
const _dp = path.resolve(_sd, "../dist");
if (fs.existsSync(_dp)) {
app.use(express.static(_dp));
app.get("*", (req, res) => {
if (!req.path.startsWith("/api/"))
res.sendFile(path.join(_dp, "index.html"));
});
console.log("Frontend serving from:", _dp);
}
'''

content = content.replace('app.listen(PORT,', static_code + 'app.listen(PORT,')
with open('backend/server.js', 'w') as f:
f.write(content)
print('server.js updated OK')
PYEOF
## 5.5 Frontend Build Karo
Yeh step ~2-3 minute lega. dist/ folder create hoga:
cd ~/public_html
NODE_OPTIONS='--max-old-space-size=512' npm run build
ls dist/  # index.html aur assets/ folder hona chahiye
## 5.6 Output Directories Banao
mkdir -p ~/public_html/Scripts/outputs/GetTask
mkdir -p ~/public_html/Scripts/outputs/GetOrderInquiry
mkdir -p ~/public_html/Scripts/outputs/Funeral_Finder
mkdir -p ~/public_html/Scripts/outputs/Updater
mkdir -p ~/public_html/Scripts/outputs/ClosingTask
mkdir -p ~/public_html/backend/data
echo 'Directories created OK'
## 5.7 Python Dependencies Install Karo
pip3 install --user requests pandas openpyxl python-dotenv
# Verify
python3 -c "import requests, pandas, openpyxl, dotenv; print('All OK')"
## 5.8 Scripts/.env File Verify/Banao
# Check karo Scripts/.env hai ya nahi
cat Scripts/.env 2>/dev/null || echo 'Missing — copy karo'

# Agar missing hai:
cp .env Scripts/.env
echo 'Scripts/.env created'
## 5.9 Backend PM2 Se Start Karo
cd ~/public_html
pm2 start backend/server.js --name 'blossom-backend'
pm2 save
pm2 status  # Status: online dikhna chahiye

# Test karo
curl http://localhost:8787/api/health
# Expected: {"ok":true,"service":"webui-backend"}
## 5.10 Nginx Configure Karo — Cloudways Dashboard Se
Yeh step browser mein karna hai (SSH se nahi):
- Browser mein Cloudways.com kholo aur login karo
- Servers > apna server (64.225.3.96) > Applications
- 'ufgachabjh' application click karo
- Left menu mein 'Application Settings' ya 'Nginx Settings' dhundo
- 'Custom Nginx Configuration' ya 'Vhost' section mein yeh paste karo:

location /api/ {
proxy_pass http://127.0.0.1:8787;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection 'upgrade';
proxy_set_header Host $host;
proxy_cache_bypass $http_upgrade;
proxy_read_timeout 300s;
}

location / {
proxy_pass http://127.0.0.1:8787;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
}
- Save/Apply karo — Nginx automatically reload hoga

# 6. Deployment Verify Karo
Sab steps complete hone ke baad yeh checks karo:
## 6.1 Terminal Se Check
# PM2 status
pm2 status
# Expected: blossom-backend | online

# Backend health
curl http://localhost:8787/api/health
# Expected: {"ok":true}

# Backend scripts API
curl http://localhost:8787/api/scripts
# Expected: JSON with 5 scripts

# Frontend served ho raha hai?
curl http://localhost:8787/ | head -5
# Expected: <!DOCTYPE html>
## 6.2 Browser Se Check
- Browser mein kholo: https://phpstack-1335521-6323887.cloudwaysapps.com/
- BlossomTask Dashboard dikhna chahiye
- 5 script panels visible hone chahiye (GetTask, GetOrderInquiry, etc.)
- Header mein 'Idle' status dikhna chahiye
- Preflight Check button click karo — pass/fail report aani chahiye

# 7. Day-to-Day Operations
## 7.1 PM2 Cheat Sheet
## 7.2 Code Update Karne Par
cd ~/public_html

# Agar git use kar rahe ho:
git pull origin main

# Frontend mein changes hue to rebuild karo:
NODE_OPTIONS='--max-old-space-size=512' npm run build

# Backend changes hue to restart karo:
pm2 restart blossom-backend

# Python script changes — restart ki zaroorat nahi
# (scripts on-demand run hote hain)
## 7.3 Server Reboot Ke Baad
# PM2 automatically start hoga agar pehle yeh kiya ho:
pm2 startup  # ek baar karna tha
pm2 save     # ek baar karna tha

# Agar nahi hua to manually:
cd ~/public_html && pm2 start backend/server.js --name 'blossom-backend'
## 7.4 Logs Check Karo
# PM2 backend logs
pm2 logs blossom-backend --lines 50

# Pipeline logs
cat ~/public_html/pipeline_logs.jsonl | tail -20

# Script-specific logs
cat ~/public_html/Scripts/outputs/GetTask/logs.txt
cat ~/public_html/Scripts/outputs/Funeral_Finder/Funeral_Finder.log

# 8. Security — Important!
⚠️  API Keys Chat Mein Share Mat Karo — EVER!
Is session mein API keys expose hui hain. Immediately yeh karo:
- Perplexity Dashboard kholo → API Keys → us key ko Revoke/Regenerate karo
- OpenAI Dashboard kholo → API Keys → us key ko Delete karo → Nai key banao
- Nai keys .env file mein update karo: nano ~/public_html/.env
- cp .env Scripts/.env
- pm2 restart blossom-backend
Future Security Tips:
- .env file kabhi git commit mat karo — .gitignore mein add karo
- API keys kisi bhi chat, email, ya document mein share mat karo
- Har 3 mahine mein API keys rotate karo
- CRM API key bhi change karo agar possible ho

# 9. Troubleshooting Guide

# 10. Quick Reference Card
## Server Credentials





## Most Used Commands
ssh master_wrkcghydas@64.225.3.96   # Login
cd ~/public_html                     # Project folder
pm2 status                           # Check status
pm2 logs blossom-backend             # View logs
pm2 restart blossom-backend          # Restart backend
npm run build                        # Rebuild frontend
curl localhost:8787/api/health       # Health check
## Pipeline Stage Files

🌸 BlossomTask Deployment Complete Guide
Prepared April 2026 | For Internal Use Only
| Version | v2.0.0 |
| --- | --- |
| Date | April 2026 |
| Server IP | 64.225.3.96 |
| Live URL | phpstack-1335521-6323887.cloudwaysapps.com |
| SSH User | master_wrkcghydas |
| Component | Status | Notes |
| --- | --- | --- |
| Frontend | React 18 + TypeScript | Vite build tool, Shadcn UI, TanStack Query |
| Backend | Node.js + Express.js | Port 8787, Job management, Cron scheduler |
| Python Scripts | Python 3.9 (5 scripts) | Perplexity AI, Pandas, Requests |
| Styling | Tailwind CSS | Dark/Light mode, responsive |
| Data Storage | JSON files | backend/data/ directory |
| Process Manager | PM2 | Keep Node.js alive 24/7 |
| OS | Debian GNU/Linux 11 (Bullseye) |
| --- | --- |
| Kernel | Linux 6.1.0 cloud-amd64 (2024-05-06) |
| --- | --- |
| RAM Total | 3.8 GB |
| --- | --- |
| RAM Free | 193 MB free (⚠️ Swap bhi full hai — 1.9GB/1.9GB) |
| --- | --- |
| Disk Space | 79 GB total — 44 GB free (43% used) |
| --- | --- |
| Component | Status | Notes |
| --- | --- | --- |
| Node.js | ✅ v18.17.1 | Already installed — bilkul sahi version |
| npm | ✅ v9.6.7 | Already installed |
| Python 3 | ✅ v3.9.2 | Installed — project ko 3.10+ chahiye tha par 3.9 bhi kaam karega |
| pip3 | ✅ v20.3.4 | Available |
| Git | ✅ v2.30.2 | Available |
| Nginx | ✅ Installed | Cloudways manage karta hai — hum direct edit nahi kar sakte |
| PM2 | ❌ Not installed | Install karna hoga (bina sudo ke) |
| sudo access | ❌ Not allowed | master_wrkcghydas ko sudo nahi — Cloudways restriction |
| NVM | ❌ Not installed | Optional — Node already hai |
| dist/ folder | ❌ Not built | npm run build karna hoga |
| Project Location | /home/master/public_html/ |
| --- | --- |
| App Name | ufgachabjh (Cloudways app identifier) |
| --- | --- |
| node_modules | Already installed (397 folders) |
| --- | --- |
| .env file | Present at /home/master/public_html/.env |
| --- | --- |
| Scripts/.env | Present at /home/master/public_html/Scripts/.env |
| --- | --- |
| Problem | Solution |
| --- | --- |
| No sudo access | Cloudways ne sudo disable kiya hai. Solution: PM2 ko ~/.npm-global/ mein install karo (user-level), Nginx ko Cloudways Dashboard se configure karo. |
| RAM tight (193MB free) | Production build (npm run build) RAM efficient hoti hai. PM2 Node.js ko single process mein chalata hai. Python scripts on-demand run hote hain, background mein nahi rehte. |
| Swap full (1.9GB/1.9GB) | npm run build ke time RAM pressure ho sakta hai. Build ke time --max-old-space-size=512 flag use karo. Agar fail ho to Cloudways Dashboard se server restart karo. |
| Nginx vhost readable nahi | Cloudways Dashboard mein Application Settings > Nginx Custom Configuration option hota hai. Wahan se proxy rules add kar sakte hain. |
| Python 3.9 vs 3.10+ | Project 3.10+ ke liye bana hai par 3.9 mein bhi kaam karega. F-strings aur basic libraries 3.9 mein available hain. |
| dist/ folder nahi bana | npm run build run karna hoga. Pehli baar ~2-3 minutes lagenge. node_modules already hai to fast hoga. |
| .env files security | API keys already .env mein hain. .gitignore mein add karo taaki git push se leak na ho. |
| SSH Command | ssh master_wrkcghydas@64.225.3.96 |
| --- | --- |
| Step | Action | Command / Details |
| --- | --- | --- |
| CMD 1 | Status dekho | pm2 status |
| CMD 2 | Logs dekho (live) | pm2 logs blossom-backend |
| CMD 3 | Backend restart | pm2 restart blossom-backend |
| CMD 4 | Backend stop | pm2 stop blossom-backend |
| CMD 5 | Backend start | pm2 start blossom-backend |
| CMD 6 | Memory check | pm2 monit |
| CMD 7 | All processes | pm2 list |
| Problem | Solution |
| --- | --- |
| URL khulta hai par blank page | dist/ folder nahi bana. Run: cd ~/public_html && npm run build |
| 502 Bad Gateway error | Backend down hai. Run: pm2 restart blossom-backend |
| API calls fail hoti hain | pm2 logs blossom-backend dekho. .env file check karo. |
| npm run build fail hota hai (RAM) | Run: NODE_OPTIONS='--max-old-space-size=512' npm run build |
| Python scripts fail hote hain | Scripts/.env exist karti hai? python3 -c 'import requests' chalao |
| pm2 command not found | source ~/.bashrc chalao — PATH reload hoga |
| Port 8787 already in use | pm2 delete blossom-backend chalao, phir restart karo |
| Server reboot ke baad blossom band | pm2 startup && pm2 save ek baar chalao |
| Nginx 404 on /api routes | Cloudways Dashboard se Nginx custom config dobara check karo |
| Dashboard dikhta hai par scripts nahi chalte | Scripts/.env file verify karo, preflight check run karo |
| Server IP | 64.225.3.96 |
| --- | --- |
| SSH User | master_wrkcghydas |
| --- | --- |
| Project Path | /home/master/public_html/ |
| --- | --- |
| Backend Port | 8787 |
| --- | --- |
| Live URL | https://phpstack-1335521-6323887.cloudwaysapps.com/ |
| --- | --- |
| Step | Action | Command / Details |
| --- | --- | --- |
| Stage 1 | GetTask.py | Scripts/outputs/GetTask/data.csv |
| Stage 2 | GetOrderInquiry.py | Scripts/outputs/GetOrderInquiry/data.csv |
| Stage 3 | Funeral_Finder.py | Scripts/outputs/Funeral_Finder/Funeral_data.csv |
| Stage 4 | Updater.py | Scripts/outputs/Updater/data.csv |
| Stage 5 | ClosingTask.py | Scripts/outputs/ClosingTask/data.csv |