const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const AdmZip = require("adm-zip");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "data");

const sitesDir = path.join(DATA_DIR, "sites");
const tempDir = path.join(DATA_DIR, "temp");
const metadataFile = path.join(DATA_DIR, "projects.json");

fs.ensureDirSync(sitesDir);
fs.ensureDirSync(tempDir);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const upload = multer({
  dest: tempDir,
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 50
  }
});

// ======================================================
// METADATA SYSTEM
// ======================================================

function loadMetadata() {
  try {
    if (!fs.existsSync(metadataFile)) return {};
    const data = fs.readJsonSync(metadataFile);
    return data && typeof data === "object" ? data : {};
  } catch (error) {
    console.error("Metadata load error:", error);
    return {};
  }
}

function saveMetadata(data) {
  try {
    fs.writeJsonSync(metadataFile, data, { spaces: 2 });
  } catch (error) {
    console.error("Metadata save error:", error);
  }
}

function getProjectMetadata(folderName) {
  const metadata = loadMetadata();

  return metadata[folderName] || {
    slug: folderName,
    title: folderName,
    description: `${folderName} website`,
    keywords: folderName,
    author: "Tamim Khan",
    previousSlugs: []
  };
}

function setProjectMetadata(folderName, data) {
  const metadata = loadMetadata();

  metadata[folderName] = {
    ...getProjectMetadata(folderName),
    ...data
  };

  saveMetadata(metadata);
}

function findProjectBySlug(slug) {
  const metadata = loadMetadata();

  for (const folderName of Object.keys(metadata)) {
    const item = metadata[folderName];

    if (
      item.slug === slug ||
      (
        Array.isArray(item.previousSlugs) &&
        item.previousSlugs.includes(slug)
      )
    ) {
      return { folderName, data: item };
    }
  }

  const directPath = path.join(sitesDir, slug);

  if (fs.existsSync(directPath)) {
    return {
      folderName: slug,
      data: {
        slug,
        title: slug,
        description: `${slug} website`,
        keywords: slug,
        author: "Tamim Khan",
        previousSlugs: []
      }
    };
  }

  return null;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

// ======================================================
// HELPERS
// ======================================================

function sanitizeSiteName(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function sanitizeFileName(name) {
  return path
    .basename(name)
    .replace(/[<>:"|?*\x00-\x1F]/g, "_");
}

function safeJoin(base, target) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(base, target);

  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error("Unsafe path detected");
  }

  return resolvedTarget;
}

function getProjectUrl(req, siteName) {
  return `${req.protocol}://${req.get("host")}/site/${encodeURIComponent(siteName)}/`;
}

// ======================================================
// HTML FINDER
// ======================================================

function findHtmlFiles(dir) {
  let results = [];

  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      results = results.concat(findHtmlFiles(fullPath));
    } else {
      const ext = path.extname(item.name).toLowerCase();

      if (ext === ".html" || ext === ".htm") {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function findBestHtml(dir) {
  const htmlFiles = findHtmlFiles(dir);

  if (!htmlFiles.length) return null;

  for (const name of [
    "index.html",
    "index.htm",
    "home.html",
    "main.html",
    "default.html"
  ]) {
    const found = htmlFiles.find(
      file => path.basename(file).toLowerCase() === name
    );

    if (found) return found;
  }

  return htmlFiles[0];
}

async function ensureIndexHtml(projectDir) {
  const existingIndex = path.join(projectDir, "index.html");

  if (fs.existsSync(existingIndex)) return existingIndex;

  const htmlFile = findBestHtml(projectDir);

  if (!htmlFile) return null;

  await fs.copy(htmlFile, existingIndex, {
    overwrite: false
  });

  return existingIndex;
}

// ======================================================
// ZIP ROOT FOLDER DETECTOR
// ======================================================

async function flattenSingleFolder(projectDir) {
  const items = fs.readdirSync(
    projectDir,
    { withFileTypes: true }
  );

  const visibleItems = items.filter(
    item =>
      item.name !== "__MACOSX" &&
      item.name !== ".DS_Store"
  );

  if (
    visibleItems.length === 1 &&
    visibleItems[0].isDirectory()
  ) {
    const folderName = visibleItems[0].name;
    const folderPath = path.join(
      projectDir,
      folderName
    );

    const htmlFiles = findHtmlFiles(folderPath);

    if (!htmlFiles.length) return;

    const tempFlatten = path.join(
      DATA_DIR,
      `flatten-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`
    );

    await fs.ensureDir(tempFlatten);

    const innerItems =
      await fs.readdir(folderPath);

    for (const item of innerItems) {
      await fs.move(
        path.join(folderPath, item),
        path.join(tempFlatten, item),
        {
          overwrite: true
        }
      );
    }

    await fs.remove(folderPath);

    const flattenedItems =
      await fs.readdir(tempFlatten);

    for (const item of flattenedItems) {
      await fs.move(
        path.join(tempFlatten, item),
        path.join(projectDir, item),
        {
          overwrite: true
        }
      );
    }

    await fs.remove(tempFlatten);
  }
}

function ensureProjectMetadata(folderName) {
  const metadata = loadMetadata();

  if (!metadata[folderName]) {
    metadata[folderName] = {
      slug: folderName,
      title: folderName,
      description: `${folderName} website`,
      keywords: folderName,
      author: "Tamim Khan",
      previousSlugs: []
    };

    saveMetadata(metadata);
  }
}

// ======================================================
// SEO HTML INJECTION
// ======================================================

function injectSEO(html, meta, liveUrl) {
  const title = escapeHtml(meta.title || "Website");
  const description = escapeAttribute(meta.description || "");
  const keywords = escapeAttribute(meta.keywords || "");
  const author = escapeAttribute(meta.author || "Tamim Khan");
  const canonical = escapeAttribute(liveUrl);

  const seoTags = `
<meta name="description" content="${description}">
<meta name="keywords" content="${keywords}">
<meta name="author" content="${author}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
`;

  let output = html;

  if (/<head[^>]*>/i.test(output)) {
    output = output.replace(
      /<head[^>]*>/i,
      match => `${match}${seoTags}<title>${title}</title>`
    );
  } else {
    output = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${seoTags}
</head>
<body>
${output}
</body>
</html>
`;
  }

  return output;
}

// ======================================================
// DASHBOARD (MAIN PAGE)
// ======================================================

app.get("/", (req, res) => {
  let projectsCount = 0;
  let totalSize = 0;

  try {
    const items = fs.readdirSync(sitesDir, { withFileTypes: true });
    const directories = items.filter(item => item.isDirectory());
    projectsCount = directories.length;

    for (const item of directories) {
      const projectPath = path.join(sitesDir, item.name);
      try {
        const files = fs.readdirSync(projectPath, { recursive: true });
        for (const file of files) {
          const full = path.join(projectPath, file);
          const stat = fs.statSync(full);
          if (stat.isFile()) {
            totalSize += stat.size;
          }
        }
      } catch {}
    }
  } catch {}

  res.send(`
<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#020617">
<title>Personal Website Hosting & Developed BY Tamim Khan</title>
<style>
:root {
  --c1:#00d9ff;
  --c2:#0066ff;
  --c3:#8b5cf6;
  --bg1:#020617;
  --bg2:#07132f;
  --text:#f8fafc;
  --muted:#94a3b8;
  --border:rgba(255,255,255,.14);
}
*{box-sizing:border-box;}
html{scroll-behavior:smooth;}
body{
  margin:0;
  min-height:100vh;
  font-family:Arial, "Segoe UI", sans-serif;
  color:var(--text);
  background:
    radial-gradient(circle at 15% 10%, var(--c3), transparent 30%),
    radial-gradient(circle at 85% 80%, var(--c2), transparent 30%),
    linear-gradient(135deg, var(--bg1), var(--bg2));
  background-size: 200% 200%;
  animation: liveBackgroundShift 12s ease infinite;
  overflow-x:hidden;
}
@keyframes liveBackgroundShift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
.container{
  position:relative; z-index:2;
  width:min(900px, 94%); margin:auto;
  padding:30px 0 60px;
}
.header{text-align:center; margin-bottom:20px;}
.logo{
  min-height:70px; display:flex;
  justify-content:center; align-items:center;
  font-size:clamp(20px, 4vw, 32px);
  font-weight:900;
}
.logo-text{
  background:linear-gradient(90deg, var(--c1), var(--c2), var(--c3), var(--c1));
  background-size:300% auto;
  -webkit-background-clip:text; background-clip:text;
  color:transparent;
  animation:titleGradient 5s linear infinite;
}
@keyframes titleGradient{
  0%{background-position:0% center;}
  100%{background-position:300% center;}
}
.subtitle{color:var(--muted); font-size:14px; margin-top:5px;}

/* Single Thin Container for Stats with RGB Glow */
.stats-container{
  display:flex;
  justify-content:space-around;
  align-items:center;
  background:rgba(8,15,35,.85);
  border:1px solid rgba(255,255,255,.12);
  border-radius:14px;
  padding:12px 15px;
  margin-bottom:20px;
  backdrop-filter:blur(10px);
  position:relative;
  box-shadow: 0 0 15px rgba(0,217,255,0.2), inset 0 0 10px rgba(139,92,246,0.15);
  animation: statsGlow 4s ease-in-out infinite alternate;
}
@keyframes statsGlow {
  0% { box-shadow: 0 0 10px rgba(0,217,255,0.2), 0 0 20px rgba(0,102,255,0.1); }
  100% { box-shadow: 0 0 20px rgba(139,92,246,0.4), 0 0 35px rgba(0,217,255,0.3); }
}
.stat-item{
  text-align:center;
  flex:1;
  border-right:1px solid rgba(255,255,255,.08);
}
.stat-item:last-child{border-right:none;}
.stat-number{font-size:18px; font-weight:900; margin-top:2px;}
.stat-label{font-size:10px; color:var(--muted); margin-top:1px; text-transform:uppercase;}

.rgb-card{position:relative;}
.rgb-card::before{
  content:""; position:absolute; inset:-2px;
  border-radius:20px;
  background:linear-gradient(90deg, #00d9ff, #0066ff, #8b5cf6, #ff007f, #00d9ff);
  background-size:400% 100%;
  animation:rgbMove 6s linear infinite;
  z-index:-2;
  filter: blur(4px);
  opacity: 0.85;
}
.rgb-card::after{
  content:""; position:absolute; inset:1px;
  border-radius:18px; background:rgba(8,15,35,.96);
  z-index:-1;
}
@keyframes rgbMove{
  0%{background-position:0% 50%;}
  100%{background-position:400% 50%;}
}
.card{
  position:relative; background:rgba(8,15,35,.88);
  border:1px solid var(--border); border-radius:18px;
  padding:22px; margin-bottom:20px;
}
.card h2{
  margin-top:0; font-size:22px;
  background:linear-gradient(90deg, var(--c1), var(--c3));
  -webkit-background-clip:text; background-clip:text;
  color:transparent;
}
label{display:block; font-weight:bold; margin:14px 0 6px; font-size:15px; color:#dbeafe;}
.input-wrap{position:relative; padding:2px; border-radius:11px; overflow:hidden; margin-bottom:15px;}
.input-wrap::before{
  content:""; position:absolute; inset:-100%;
  background:conic-gradient(from 0deg, #00d9ff, #0066ff, #8b5cf6, #ff007f, #00d9ff);
  animation:rotateRGB 4s linear infinite;
}
.input-wrap input{position:relative; z-index:2;}
@keyframes rotateRGB{to{transform:rotate(360deg);}}
input[type=text], input[type=file]{
  width:100%; padding:12px; border:0; outline:none;
  border-radius:10px; background:#020617; color:white; font-size:15px;
}
input[type=file]{border:1px solid rgba(255,255,255,.08);}
.drop{
  position:relative; border:2px dashed var(--c1);
  padding:20px; text-align:center; border-radius:14px;
  margin-bottom:18px; background:rgba(2,6,23,.65);
}
.deploy-btn{
  width:100%; border:0; padding:15px;
  border-radius:11px; color:white; font-size:16px; font-weight:900;
  cursor:pointer;
  background:linear-gradient(90deg, #0066ff, #8b5cf6, #ff007f, #0066ff);
  background-size:300% auto;
  animation:buttonGradient 4s linear infinite;
  box-shadow: 0 0 15px rgba(0,217,255,0.4);
}
@keyframes buttonGradient{to{background-position:300% center;}}
.menu-btn{
  display:block; width:100%; text-align:center; padding:15px;
  background:linear-gradient(135deg, #2563eb, #7c3aed, #db2777);
  background-size: 200% 200%;
  animation: liveBtnGlow 5s ease infinite;
  color:white;
  text-decoration:none; border-radius:12px; font-weight:bold; font-size:16px;
  margin-top:15px; box-shadow:0 4px 20px rgba(37,99,235,.4);
  transition:transform 0.2s;
}
@keyframes liveBtnGlow {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
.menu-btn:hover{transform:translateY(-2px);}
.note{color:#718096; font-size:12px; margin-bottom:12px;}
</style>
</head>
<body>

<div class="container">

<div class="header">
  <div class="card rgb-card" style="padding: 15px; margin-bottom: 15px;">
    <div class="logo">
      <div class="logo-text">Personal Website Hosting & Developed BY TâMïM Khan</div>
    </div>
  </div>
  <div class="subtitle">Upload → Deploy → Manage → Update → Live</div>
</div>

<div class="stats-container">
  <div class="stat-item">
    <div style="font-size:16px;">🌐</div>
    <div class="stat-number">${projectsCount}</div>
    <div class="stat-label">Total Projects</div>
  </div>
  <div class="stat-item">
    <div style="font-size:16px;">🟢</div>
    <div class="stat-number">${projectsCount}</div>
    <div class="stat-label">Live Websites</div>
  </div>
  <div class="stat-item">
    <div style="font-size:16px;">💾</div>
    <div class="stat-number">${(totalSize / 1024).toFixed(1)} KB</div>
    <div class="stat-label">Total Storage</div>
  </div>
</div>

<div class="card rgb-card">
  <h2>🚀 নতুন প্রজেক্ট Deploy করুন</h2>
  <form id="deployForm" action="/deploy" method="POST" enctype="multipart/form-data">
    <label>Project Name</label>
    <div class="input-wrap">
      <input type="text" name="sitename" required placeholder="my-project" pattern="[A-Za-z0-9_-]+" maxlength="50"/>
    </div>
    <div class="note">শুধু English letters, numbers, - এবং _ ব্যবহার করুন।</div>
    <label>Website Files</label>
    <div id="dropBox" class="drop">
      <div style="font-size:32px; margin-bottom:6px">📦</div>
      <div style="font-size:15px; font-weight:bold">HTML / CSS / JS অথবা ZIP ফাইল নির্বাচন করুন</div>
      <div style="margin:6px 0 10px; color:#64748b; font-size:12px">Drag & Drop করেও file দেওয়া যাবে</div>
      <input type="file" id="fileInput" name="projectfiles" multiple required accept=".html, .htm, .css, .js, .json, .png, .jpg, .jpeg, .gif, .svg, .webp, .ico, .txt, .zip">
      <div id="fileStatus" style="margin-top:8px; color:#64748b; font-size:12px">কোনো file নির্বাচন করা হয়নি</div>
    </div>
    <button id="deployBtn" class="deploy-btn" type="submit">🚀 DEPLOY WEBSITE</button>
  </form>
</div>

<div class="card rgb-card" style="text-align: center; padding: 20px;">
  <h2 style="margin-bottom: 8px;">📂 My Projects</h2>
  <p style="color: var(--muted); font-size: 13px; margin-bottom: 15px;">আপনার সকল প্রজেক্ট দেখতে এবং ম্যানেজ করতে নিচের বাটনে ক্লিক করুন।</p>
  <a href="/projects" class="menu-btn">📂 View All Projects</a>
</div>

</div>

<script>
const fileInput = document.getElementById("fileInput");
const fileStatus = document.getElementById("fileStatus");
if(fileInput){
  fileInput.addEventListener("change", ()=>{
    if(fileInput.files.length){
      fileStatus.textContent = "✅ " + fileInput.files.length + "টি file selected";
    }
  });
}
const deployForm = document.getElementById("deployForm");
const deployBtn = document.getElementById("deployBtn");
if(deployForm){
  deployForm.addEventListener("submit", ()=>{
    deployBtn.innerHTML = "⏳ UPLOADING & DEPLOYING...";
    deployBtn.style.pointerEvents = "none";
    deployBtn.disabled = true;
  });
}
</script>
</body>
</html>
`);
});

// ======================================================
// MY PROJECTS PAGE (SEPARATE PAGE)
// ======================================================

app.get("/projects", (req, res) => {
  let projects = [];
  const metadata = loadMetadata();

  try {
    projects = fs
      .readdirSync(sitesDir, { withFileTypes: true })
      .filter(item => item.isDirectory())
      .map(item => {
        const projectPath = path.join(sitesDir, item.name);
        let size = 0;
        try {
          const files = fs.readdirSync(projectPath, { recursive: true });
          for (const file of files) {
            try {
              const full = path.join(projectPath, file);
              const stat = fs.statSync(full);
              if (stat.isFile()) size += stat.size;
            } catch {}
          }
        } catch {}

        const meta = metadata[item.name] || {
          slug: item.name,
          title: item.name,
          description: `${item.name} website`,
          keywords: item.name,
          author: "Tamim Khan",
          previousSlugs: []
        };

        return {
          name: item.name,
          slug: meta.slug || item.name,
          title: meta.title || item.name,
          description: meta.description || "",
          keywords: meta.keywords || "",
          size: (size / 1024).toFixed(1)
        };
      });
  } catch {}

  const projectHTML = projects.length
    ? projects.map(
        project => `
      <div class="project" data-search="${escapeAttribute(
        `${project.title} ${project.name} ${project.slug} ${project.description} ${project.keywords}`
      )}">
        <div class="project-info">
          <div class="project-topline">
            <div class="project-icon">🌐</div>
            <div>
              <div class="project-name">${escapeHtml(project.title)}</div>
              <div class="project-id">Project ID: ${escapeHtml(project.name)}</div>
            </div>
          </div>
          <div class="project-url-row">
            <a class="project-url" href="/site/${encodeURIComponent(project.slug)}/" target="_blank" rel="noopener">/site/${escapeHtml(project.slug)}/</a>
            <button class="copy-url" type="button" data-url="/site/${encodeURIComponent(project.slug)}/">📋 Copy</button>
          </div>
          <div class="project-meta">
            <span>💾 ${escapeHtml(project.size)} KB</span>
            <span>● Live</span>
          </div>
        </div>
        <div class="actions">
          <a class="action-btn live-btn" href="/site/${encodeURIComponent(project.slug)}/" target="_blank" rel="noopener">🌐 Live</a>
          <a class="action-btn edit-btn" href="/edit/${encodeURIComponent(project.name)}">✏️ Edit</a>
          <form action="/delete/${encodeURIComponent(project.name)}" method="POST" onsubmit="return confirm('এই project delete করতে চান?')">
            <button class="action-btn delete-btn" type="submit">🗑 Delete</button>
          </form>
        </div>
      </div>
    `
      ).join("")
    : `
      <div class="empty">
        <div class="empty-icon">📂</div>
        <b>এখনো কোনো project deploy করা হয়নি।</b>
      </div>
    `;

  res.send(`
<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>My Projects - Tamim Khan</title>
<style>
:root {
  --c1:#00d9ff;
  --c2:#0066ff;
  --c3:#8b5cf6;
  --bg1:#020617;
  --bg2:#07132f;
  --text:#f8fafc;
  --muted:#94a3b8;
  --border:rgba(255,255,255,.14);
}
*{box-sizing:border-box;}
body{
  margin:0;
  min-height:100vh;
  font-family:Arial, sans-serif;
  color:var(--text);
  background:linear-gradient(135deg, var(--bg1), var(--bg2));
  background-size: 200% 200%;
  animation: liveBackgroundShift 12s ease infinite;
  padding:20px 0 50px;
}
@keyframes liveBackgroundShift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
.container{width:min(900px, 94%); margin:auto;}
.card{
  background:rgba(8,15,35,.88);
  border:1px solid var(--border); border-radius:18px;
  padding:22px; margin-bottom:20px;
  box-shadow:0 20px 60px rgba(0,0,0,.35);
}
.section-head{
  display:flex; justify-content:space-between;
  align-items:center; gap:15px; margin-bottom:18px; flex-wrap:wrap;
}
.section-head h2{margin:0; font-size:22px; color:var(--c1);}
.search-wrap{position:relative; width:min(300px, 100%);}
.search-wrap input{width:100%; padding:10px 10px 10px 38px; border-radius:10px; border:1px solid var(--border); background:#020617; color:white; outline:none;}
.search-icon{position:absolute; left:12px; top:50%; transform:translateY(-50%);}
.projects{display:grid; gap:12px;}
.project{
  display:flex; justify-content:space-between;
  align-items:center; gap:15px; padding:15px; border-radius:14px;
  background:rgba(2,6,23,.75); border:1px solid rgba(255,255,255,.08);
  flex-wrap:wrap;
}
.project-info{min-width:0; flex:1;}
.project-topline{display:flex; align-items:center; gap:10px;}
.project-icon{font-size:18px;}
.project-name{font-size:16px; font-weight:800; word-break:break-word;}
.project-id{color:#64748b; font-size:11px;}
.project-url-row{display:flex; align-items:center; gap:8px; margin-top:8px;}
.project-url{color:var(--c1); font-size:13px; text-decoration:none; word-break:break-all;}
.copy-url{border:0; background:rgba(0,217,255,.1); color:#bae6fd; padding:5px 8px; border-radius:6px; cursor:pointer;}
.project-meta{display:flex; gap:10px; color:#64748b; font-size:11px; margin-top:6px;}
.project-meta span:last-child{color:#4ade80;}
.actions{display:flex; gap:6px; flex-wrap:wrap;}
.action-btn{padding:8px 12px; border-radius:8px; color:white; font-weight:bold; font-size:13px; text-decoration:none; border:0; cursor:pointer;}
.live-btn{background:#059669;}
.edit-btn{background:#2563eb;}
.delete-btn{background:#dc2626;}
.empty{text-align:center; padding:30px; color:#64748b;}
.back-btn{display:inline-block; margin-bottom:15px; color:var(--c1); text-decoration:none; font-weight:bold;}
.hidden-project{display:none!important;}
</style>
</head>
<body>
<div class="container">
<a href="/" class="back-btn">← Back to Dashboard</a>
<div class="card">
  <div class="section-head">
    <h2>📂 My Projects List</h2>
    <div class="search-wrap">
      <span class="search-icon">🔍</span>
      <input id="projectSearch" type="text" placeholder="প্রজেক্ট খুঁজুন...">
    </div>
  </div>
  <div id="projectsList" class="projects">
    ${projectHTML}
  </div>
  <div id="noSearchResult" class="empty" style="display:none">
    <b>কোনো matching project পাওয়া যায়নি।</b>
  </div>
</div>
</div>
<script>
const projectSearch = document.getElementById("projectSearch");
const noSearchResult = document.getElementById("noSearchResult");
if(projectSearch){
  projectSearch.addEventListener("input", ()=>{
    const query = projectSearch.value.trim().toLowerCase();
    const projects = [...document.querySelectorAll(".project")];
    let visible = 0;
    projects.forEach(project=>{
      const text = (project.dataset.search || "").toLowerCase();
      const match = !query || text.includes(query);
      project.classList.toggle("hidden-project", !match);
      if(match) visible++;
    });
    noSearchResult.style.display = visible ? "none" : "block";
  });
}
document.querySelectorAll(".copy-url").forEach(button=>{
  button.addEventListener("click", async()=>{
    const fullUrl = new URL(button.dataset.url || "", window.location.origin).href;
    try{
      await navigator.clipboard.writeText(fullUrl);
      button.textContent = "✅ Copied";
      setTimeout(()=> button.textContent = "📋 Copy", 1500);
    }catch{}
  });
});
</script>
</body>
</html>
`);
});

// ======================================================
// DEPLOY
// ======================================================

app.post(
  "/deploy",
  upload.array("projectfiles", 50),
  async (req, res) => {
    const siteName = sanitizeSiteName(req.body.sitename);
    const files = req.files || [];

    if (!siteName || !files.length) {
      return res.status(400).send("Invalid project name or files.");
    }

    const targetDir = safeJoin(sitesDir, siteName);

    try {
      await fs.remove(targetDir);
      await fs.ensureDir(targetDir);

      if (
        files.length === 1 &&
        path.extname(files[0].originalname).toLowerCase() === ".zip"
      ) {
        const zip = new AdmZip(files[0].path);
        const entries = zip.getEntries();

        for (const entry of entries) {
          if (entry.isDirectory) continue;
          let entryName = entry.entryName.replace(/\\/g, "/");
          entryName = entryName.replace(/^\/+/, "").replace(/^(\.\.\/)+/, "");
          if (!entryName) continue;

          const outputPath = safeJoin(targetDir, entryName);
          await fs.ensureDir(path.dirname(outputPath));
          fs.writeFileSync(outputPath, entry.getData());
        }

        await fs.remove(files[0].path);
        await flattenSingleFolder(targetDir);
      } else {
        for (const file of files) {
          const safeName = sanitizeFileName(file.originalname);
          const destination = safeJoin(targetDir, safeName);
          await fs.move(file.path, destination, { overwrite: true });
        }
      }

      await ensureIndexHtml(targetDir);
      ensureProjectMetadata(siteName);
      const meta = getProjectMetadata(siteName);
      const liveUrl = getProjectUrl(req, meta.slug || siteName);

      res.send(`
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Success</title></head>
<body style="background:#020617;color:white;font-family:Arial;text-align:center;padding-top:100px">
<h1>🎉 Deployment Successful!</h1>
<p><a href="${escapeAttribute(liveUrl)}" target="_blank" style="color:#38bdf8">${escapeHtml(liveUrl)}</a></p>
<br><a href="/" style="background:#334155;color:white;padding:10px 20px;text-decoration:none;border-radius:8px;">← Dashboard</a>
</body>
</html>
`);
    } catch (error) {
      console.error(error);
      res.status(500).send("Deploy error.");
    }
  }
);

// ======================================================
// EDIT PROJECT PAGE
// ======================================================

app.get("/edit/:project", (req, res) => {
  const folderName = sanitizeSiteName(req.params.project);
  const projectDir = safeJoin(sitesDir, folderName);

  if (!fs.existsSync(projectDir)) {
    return res.status(404).send("Project not found.");
  }

  ensureProjectMetadata(folderName);
  const meta = getProjectMetadata(folderName);

  res.send(`
<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<title>Edit Project</title>
<style>
body{background:#020617;color:white;font-family:Arial;padding:20px;}
.box{max-width:600px;margin:auto;background:#0f172a;padding:25px;border-radius:14px;border:1px solid #334155;}
input, textarea{width:100%;padding:10px;margin:10px 0;background:#020617;color:white;border:1px solid #334155;border-radius:8px;}
button{padding:10px 15px;background:#2563eb;color:white;border:0;border-radius:8px;cursor:pointer;}
</style>
</head>
<body>
<div class="box">
<h2>✏️ Edit Project: ${escapeHtml(folderName)}</h2>
<form action="/update/${encodeURIComponent(folderName)}" method="POST" enctype="multipart/form-data">
<label>Update Files (ZIP or multiple files)</label>
<input type="file" name="projectfiles" required multiple>
<button type="submit">🔄 Update Files</button>
</form>
<br>
<form action="/save-settings/${encodeURIComponent(folderName)}" method="POST">
<label>URL Slug</label>
<input type="text" name="slug" value="${escapeAttribute(meta.slug || folderName)}" required>
<label>Title</label>
<input type="text" name="title" value="${escapeAttribute(meta.title || "")}">
<label>Description</label>
<textarea name="description">${escapeHtml(meta.description || "")}</textarea>
<button type="submit">💾 Save Settings</button>
</form>
<br><a href="/projects" style="color:#38bdf8">← Back to My Projects</a>
</div>
</body>
</html>
`);
});

// ======================================================
// UPDATE EXISTING PROJECT
// ======================================================

app.post("/update/:project", upload.array("projectfiles", 50), async (req, res) => {
  const folderName = sanitizeSiteName(req.params.project);
  const files = req.files || [];
  const targetDir = safeJoin(sitesDir, folderName);

  if (!fs.existsSync(targetDir) || !files.length) {
    return res.status(400).send("Invalid request.");
  }

  try {
    const updateDir = path.join(DATA_DIR, `update-${Date.now()}`);
    await fs.ensureDir(updateDir);

    if (files.length === 1 && path.extname(files[0].originalname).toLowerCase() === ".zip") {
      const zip = new AdmZip(files[0].path);
      zip.extractAllTo(updateDir, true);
      await fs.remove(files[0].path);
      await flattenSingleFolder(updateDir);
    } else {
      for (const file of files) {
        await fs.move(file.path, safeJoin(updateDir, sanitizeFileName(file.originalname)), { overwrite: true });
      }
    }

    await ensureIndexHtml(updateDir);
    await fs.remove(targetDir);
    await fs.move(updateDir, targetDir);

    res.redirect(`/edit/${encodeURIComponent(folderName)}`);
  } catch (error) {
    res.status(500).send("Update error.");
  }
});

// ======================================================
// SAVE SETTINGS
// ======================================================

app.post("/save-settings/:project", async (req, res) => {
  const folderName = sanitizeSiteName(req.params.project);
  const newSlug = sanitizeSiteName(req.body.slug);
  if (!newSlug) return res.status(400).send("Invalid slug.");

  const oldMeta = getProjectMetadata(folderName);
  setProjectMetadata(folderName, {
    slug: newSlug,
    title: String(req.body.title || oldMeta.title || folderName),
    description: String(req.body.description || oldMeta.description || "")
  });

  res.redirect(`/edit/${encodeURIComponent(folderName)}`);
});

// ======================================================
// DELETE
// ======================================================

app.post("/delete/:sitename", async (req, res) => {
  const siteName = sanitizeSiteName(req.params.sitename);
  if (siteName) {
    await fs.remove(safeJoin(sitesDir, siteName));
    const metadata = loadMetadata();
    delete metadata[siteName];
    saveMetadata(metadata);
  }
  res.redirect("/projects");
});

// ======================================================
// SITEMAP & ROBOTS
// ======================================================

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${req.protocol}://${req.get("host")}/sitemap.xml`);
});

app.get("/sitemap.xml", (req, res) => {
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${req.protocol}://${req.get("host")}/</loc></url></urlset>`);
});

// ======================================================
// LIVE SITE RENDER
// ======================================================

app.use("/site/:sitename", async (req, res, next) => {
  try {
    const requestedSlug = sanitizeSiteName(req.params.sitename);
    const project = findProjectBySlug(requestedSlug);

    if (!project) return res.status(404).send("404 Not Found");

    const folderName = project.folderName;
    const meta = getProjectMetadata(folderName);
    const sitePath = safeJoin(sitesDir, folderName);

    if (meta.slug && meta.slug !== requestedSlug) {
      return res.redirect(301, `/site/${encodeURIComponent(meta.slug)}${req.path === "/" ? "/" : req.path}`);
    }

    if (req.path === "/" || req.path === "") {
      let indexFile = path.join(sitePath, "index.html");
      if (!fs.existsSync(indexFile)) indexFile = findBestHtml(sitePath);

      if (indexFile) {
        const html = await fs.readFile(indexFile, "utf8");
        return res.type("html").send(injectSEO(html, meta, getProjectUrl(req, meta.slug || folderName)));
      }
      return res.status(404).send("No HTML found.");
    }

    express.static(sitePath)(req, res, next);
  } catch (error) {
    next(error);
  }
});

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
