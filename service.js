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

    return data && typeof data === "object"
      ? data
      : {};
  } catch (error) {
    console.error("Metadata load error:", error);
    return {};
  }
}

function saveMetadata(data) {
  try {
    fs.writeJsonSync(metadataFile, data, {
      spaces: 2
    });
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
      return {
        folderName,
        data: item
      };
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
// PROJECT HELPERS
// ======================================================

function getAllProjects() {
  const metadata = loadMetadata();
  let projects = [];

  try {
    projects = fs
      .readdirSync(sitesDir, {
        withFileTypes: true
      })
      .filter(item => item.isDirectory())
      .map(item => {
        const projectPath = path.join(
          sitesDir,
          item.name
        );

        let size = 0;

        try {
          const files = fs.readdirSync(
            projectPath,
            { recursive: true }
          );

          for (const file of files) {
            try {
              const full = path.join(
                projectPath,
                file
              );

              const stat = fs.statSync(full);

              if (stat.isFile()) {
                size += stat.size;
              }
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
          author: meta.author || "Tamim Khan",
          size: (size / 1024).toFixed(1)
        };
      });
  } catch (error) {
    console.error("Project read error:", error);
  }

  return projects;
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
// HTML FINDER
// ======================================================

function findHtmlFiles(dir) {
  let results = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  const items = fs.readdirSync(dir, {
    withFileTypes: true
  });

  for (const item of items) {
    const fullPath = path.join(
      dir,
      item.name
    );

    if (item.isDirectory()) {
      results = results.concat(
        findHtmlFiles(fullPath)
      );
    } else {
      const ext = path
        .extname(item.name)
        .toLowerCase();

      if (
        ext === ".html" ||
        ext === ".htm"
      ) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function findBestHtml(dir) {
  const htmlFiles = findHtmlFiles(dir);

  if (!htmlFiles.length) {
    return null;
  }

  for (
    const name of [
      "index.html",
      "index.htm",
      "home.html",
      "main.html",
      "default.html"
    ]
  ) {
    const found = htmlFiles.find(
      file =>
        path.basename(file).toLowerCase() === name
    );

    if (found) {
      return found;
    }
  }

  return htmlFiles[0];
}

async function ensureIndexHtml(projectDir) {
  const existingIndex = path.join(
    projectDir,
    "index.html"
  );

  if (fs.existsSync(existingIndex)) {
    return existingIndex;
  }

  const htmlFile = findBestHtml(projectDir);

  if (!htmlFile) {
    return null;
  }

  await fs.copy(
    htmlFile,
    existingIndex,
    {
      overwrite: false
    }
  );

  console.log(
    `Automatic entry created: ${htmlFile} -> ${existingIndex}`
  );

  return existingIndex;
}

// ======================================================
// ZIP ROOT FOLDER DETECTOR
// ======================================================

async function flattenSingleFolder(projectDir) {
  const items = fs.readdirSync(
    projectDir,
    {
      withFileTypes: true
    }
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
    const folderName =
      visibleItems[0].name;

    const folderPath =
      path.join(
        projectDir,
        folderName
      );

    const htmlFiles =
      findHtmlFiles(folderPath);

    if (!htmlFiles.length) {
      return;
    }

    console.log(
      `Detected project root folder: ${folderName}`
    );

    const tempFlatten = path.join(
      DATA_DIR,
      `flatten-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`
    );

    await fs.ensureDir(
      tempFlatten
    );

    const innerItems =
      await fs.readdir(folderPath);

    for (const item of innerItems) {
      await fs.move(
        path.join(
          folderPath,
          item
        ),
        path.join(
          tempFlatten,
          item
        ),
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
        path.join(
          tempFlatten,
          item
        ),
        path.join(
          projectDir,
          item
        ),
        {
          overwrite: true
        }
      );
    }

    await fs.remove(
      tempFlatten
    );
  }
}

// ======================================================
// SEO HTML INJECTION
// ======================================================

function injectSEO(html, meta, liveUrl) {
  const title = escapeHtml(
    meta.title || "Website"
  );

  const description =
    escapeAttribute(
      meta.description || ""
    );

  const keywords =
    escapeAttribute(
      meta.keywords || ""
    );

  const author =
    escapeAttribute(
      meta.author || "Tamim Khan"
    );

  const canonical =
    escapeAttribute(liveUrl);

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

<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">

`;

  let output = html;

  if (/<head[^>]*>/i.test(output)) {
    output = output.replace(
      /<head[^>]*>/i,
      match =>
        `${match}${seoTags}<title>${title}</title>`
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
// SHARED PAGE STYLE
// ======================================================

const sharedCSS = `
:root{
  --c1:#00d9ff;
  --c2:#0066ff;
  --c3:#8b5cf6;
  --bg1:#020617;
  --bg2:#07132f;
  --text:#f8fafc;
  --muted:#94a3b8;
}

*{
  box-sizing:border-box;
}

html{
  scroll-behavior:smooth;
}

body{
  margin:0;
  min-height:100vh;
  font-family:Arial,"Segoe UI",sans-serif;
  color:var(--text);
  background:
    radial-gradient(
      circle at 15% 10%,
      var(--c3),
      transparent 30%
    ),
    radial-gradient(
      circle at 85% 80%,
      var(--c2),
      transparent 30%
    ),
    linear-gradient(
      135deg,
      var(--bg1),
      var(--bg2)
    );
}

.container{
  width:min(1100px,94%);
  margin:auto;
  padding:35px 0 70px;
}

.header{
  text-align:center;
  margin-bottom:28px;
}

.logo{
  font-size:clamp(30px,7vw,58px);
  font-weight:900;
}

.gradient-text{
  background:
    linear-gradient(
      90deg,
      var(--c1),
      var(--c2),
      var(--c3)
    );
  -webkit-background-clip:text;
  background-clip:text;
  color:transparent;
}

.subtitle{
  color:var(--muted);
  margin-top:10px;
  font-size:16px;
}

.top-nav{
  display:flex;
  justify-content:center;
  gap:10px;
  flex-wrap:wrap;
  margin:0 0 25px;
}

.nav-btn{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:11px 17px;
  border-radius:11px;
  text-decoration:none;
  color:#fff;
  font-weight:800;
  background:#1e293b;
  border:1px solid rgba(255,255,255,.1);
  transition:.25s ease;
}

.nav-btn:hover{
  transform:translateY(-2px);
  background:#334155;
}

.card{
  position:relative;
  background:rgba(8,15,35,.9);
  border:1px solid rgba(255,255,255,.13);
  border-radius:22px;
  padding:27px;
  margin-bottom:22px;
  box-shadow:
    0 20px 60px rgba(0,0,0,.35);
  backdrop-filter:blur(14px);
}

.card h2{
  margin-top:0;
}

.rgb-card::before{
  content:"";
  position:absolute;
  inset:-2px;
  border-radius:23px;
  background:
    linear-gradient(
      90deg,
      #00d9ff,
      #0066ff,
      #8b5cf6,
      #00d9ff
    );
  background-size:300% 100%;
  animation:rgbMove 8s linear infinite;
  z-index:-2;
}

.rgb-card::after{
  content:"";
  position:absolute;
  inset:1px;
  border-radius:20px;
  background:rgba(8,15,35,.96);
  z-index:-1;
}

@keyframes rgbMove{
  0%{
    background-position:0% 50%;
  }

  100%{
    background-position:300% 50%;
  }
}

.stats{
  display:grid;
  grid-template-columns:
    repeat(3,1fr);
  gap:14px;
  margin-bottom:22px;
}

.stat{
  padding:18px;
  border-radius:16px;
  background:rgba(2,6,23,.7);
  border:1px solid rgba(255,255,255,.1);
}

.stat-icon{
  font-size:24px;
}

.stat-number{
  font-size:27px;
  font-weight:900;
  margin-top:5px;
}

.stat-label{
  color:var(--muted);
  font-size:12px;
  margin-top:3px;
}

.box-grid{
  display:grid;
  grid-template-columns:
    repeat(2,1fr);
  gap:20px;
}

.big-box{
  display:block;
  text-decoration:none;
  color:white;
  padding:35px 25px;
  min-height:250px;
  border-radius:20px;
  background:
    linear-gradient(
      135deg,
      rgba(0,102,255,.25),
      rgba(139,92,246,.2)
    );
  border:1px solid rgba(255,255,255,.12);
  transition:
    transform .3s ease,
    box-shadow .3s ease,
    border-color .3s ease;
}

.big-box:hover{
  transform:translateY(-7px);
  box-shadow:
    0 20px 50px rgba(0,0,0,.35),
    0 0 30px rgba(0,217,255,.15);
  border-color:var(--c1);
}

.big-icon{
  font-size:60px;
  margin-bottom:20px;
}

.big-title{
  font-size:27px;
  font-weight:900;
  margin-bottom:10px;
}

.big-text{
  color:#94a3b8;
  line-height:1.7;
}

.arrow{
  display:inline-block;
  margin-top:20px;
  color:#38bdf8;
  font-weight:900;
}

label{
  display:block;
  margin:0 0 9px;
  font-size:16px;
  font-weight:800;
}

input[type=text],
input[type=file],
textarea{
  width:100%;
  padding:15px;
  border:1px solid #334155;
  outline:none;
  border-radius:12px;
  background:#020617;
  color:#fff;
  font-size:16px;
  margin-bottom:18px;
}

textarea{
  min-height:110px;
  resize:vertical;
}

input:focus,
textarea:focus{
  border-color:#38bdf8;
  box-shadow:0 0 0 3px rgba(56,189,248,.1);
}

.drop{
  border:2px dashed #00d9ff;
  padding:32px 20px;
  text-align:center;
  border-radius:16px;
  margin-bottom:20px;
  background:rgba(2,6,23,.65);
  transition:.25s ease;
}

.drop:hover{
  border-color:#8b5cf6;
  transform:translateY(-2px);
}

.deploy-btn,
.primary-btn{
  display:inline-flex;
  justify-content:center;
  align-items:center;
  width:100%;
  padding:16px;
  border:0;
  border-radius:13px;
  color:#fff;
  background:
    linear-gradient(
      90deg,
      #0066ff,
      #8b5cf6,
      #0066ff
    );
  background-size:200% auto;
  font-size:17px;
  font-weight:900;
  cursor:pointer;
  animation:buttonMove 5s linear infinite;
}

@keyframes buttonMove{
  to{
    background-position:200% center;
  }
}

.project{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:18px;
  padding:19px;
  margin-bottom:14px;
  border-radius:16px;
  background:rgba(2,6,23,.75);
  border:1px solid rgba(255,255,255,.09);
  transition:.25s ease;
}

.project:hover{
  transform:translateY(-3px);
  border-color:#38bdf8;
  box-shadow:0 0 25px rgba(0,217,255,.12);
}

.project-info{
  flex:1;
  min-width:0;
}

.project-title{
  font-size:19px;
  font-weight:900;
  word-break:break-word;
}

.project-id{
  color:#64748b;
  font-size:12px;
  margin-top:4px;
  word-break:break-all;
}

.project-url{
  display:inline-block;
  margin-top:10px;
  color:#38bdf8;
  word-break:break-all;
  text-decoration:none;
}

.project-description{
  color:#94a3b8;
  font-size:13px;
  margin-top:8px;
  line-height:1.5;
}

.project-meta{
  display:flex;
  gap:12px;
  flex-wrap:wrap;
  color:#64748b;
  font-size:12px;
  margin-top:9px;
}

.actions{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  justify-content:flex-end;
}

.action{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:11px 14px;
  border-radius:10px;
  border:0;
  color:#fff;
  text-decoration:none;
  font-weight:800;
  cursor:pointer;
}

.live{
  background:#059669;
}

.edit{
  background:#2563eb;
}

.delete{
  background:#dc2626;
}

.copy{
  background:#334155;
}

.action:hover{
  filter:brightness(1.15);
  transform:translateY(-2px);
}

.empty{
  text-align:center;
  padding:45px 20px;
  color:#94a3b8;
}

.empty-icon{
  font-size:50px;
  margin-bottom:10px;
}

.search{
  width:100%;
  padding:14px;
  border-radius:12px;
  border:1px solid #334155;
  background:#020617;
  color:#fff;
  outline:none;
  margin-bottom:18px;
}

.help{
  color:#94a3b8;
  font-size:13px;
  line-height:1.7;
}

.url-preview{
  padding:14px;
  border-radius:12px;
  background:#020617;
  border:1px solid #2563eb;
  color:#38bdf8;
  word-break:break-all;
  margin-bottom:20px;
}

.toast{
  position:fixed;
  left:50%;
  bottom:25px;
  transform:translate(-50%,20px);
  opacity:0;
  pointer-events:none;
  padding:12px 18px;
  border-radius:12px;
  background:#0f172a;
  border:1px solid #38bdf8;
  color:#fff;
  transition:.3s ease;
  z-index:100;
}

.toast.show{
  opacity:1;
  transform:translate(-50%,0);
}

@media(max-width:750px){
  .box-grid{
    grid-template-columns:1fr;
  }

  .stats{
    grid-template-columns:1fr;
  }

  .project{
    flex-direction:column;
    align-items:stretch;
  }

  .actions{
    justify-content:stretch;
  }

  .action{
    flex:1;
  }
}
`;

// ======================================================
// MAIN DASHBOARD
// ======================================================

app.get("/", (req, res) => {
  const projects = getAllProjects();

  const totalSize =
    projects.reduce(
      (sum, project) =>
        sum + Number(project.size || 0),
      0
    );

  res.send(`
<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>TM Website Deploy</title>

<style>
${sharedCSS}
</style>
</head>

<body>

<div class="container">

<div class="header">
  <div class="logo gradient-text">
    🌐 TM Website Deploy
  </div>

  <div class="subtitle">
    Upload → Deploy → Manage → Update → Live
  </div>
</div>

<div class="top-nav">
  <a class="nav-btn" href="/">
    🏠 Dashboard
  </a>

  <a class="nav-btn" href="/deploy-page">
    🚀 Deploy
  </a>

  <a class="nav-btn" href="/projects">
    📂 Project View
  </a>
</div>

<div class="stats">

  <div class="stat">
    <div class="stat-icon">🌐</div>
    <div class="stat-number">
      ${projects.length}
    </div>
    <div class="stat-label">
      TOTAL PROJECTS
    </div>
  </div>

  <div class="stat">
    <div class="stat-icon">🟢</div>
    <div class="stat-number">
      ${projects.length}
    </div>
    <div class="stat-label">
      LIVE WEBSITES
    </div>
  </div>

  <div class="stat">
    <div class="stat-icon">💾</div>
    <div class="stat-number">
      ${totalSize.toFixed(1)} KB
    </div>
    <div class="stat-label">
      TOTAL STORAGE
    </div>
  </div>

</div>

<div class="box-grid">

  <!-- DEPLOY BOX -->

  <a
    href="/deploy-page"
    class="big-box"
  >

    <div class="big-icon">
      🚀
    </div>

    <div class="big-title">
      Deploy Website
    </div>

    <div class="big-text">
      HTML, CSS, JS অথবা ZIP file upload
      করে নতুন website deploy করুন।
      Project name, file upload এবং
      deployment সব এই আলাদা page-এ হবে।
    </div>

    <div class="arrow">
      OPEN DEPLOY PAGE →
    </div>

  </a>


  <!-- PROJECT VIEW BOX -->

  <a
    href="/projects"
    class="big-box"
  >

    <div class="big-icon">
      📂
    </div>

    <div class="big-title">
      Project View
    </div>

    <div class="big-text">
      আপনার সব deployed website একসাথে
      দেখুন। এখান থেকে Live website,
      Edit, Update, URL এবং Delete
      manage করতে পারবেন।
    </div>

    <div class="arrow">
      OPEN PROJECTS →
    </div>

  </a>

</div>

<div class="card rgb-card"
style="margin-top:22px;text-align:center">

<h2 class="gradient-text">
  👨‍💻 TM Website Manager
</h2>

<p class="help">
আপনার website deploy করার পর
Project View page থেকে পুরো project
manage করতে পারবেন।
</p>

</div>

</div>

</body>
</html>
`);
});

// ======================================================
// DEPLOY PAGE
// ======================================================

app.get("/deploy-page", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="bn">

<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>Deploy Website - TM</title>

<style>
${sharedCSS}

.drop.uploading{
  animation:shake .3s infinite alternate;
}

@keyframes shake{
  from{
    transform:translateX(-2px);
  }
  to{
    transform:translateX(2px);
  }
}
</style>

</head>

<body>

<div class="container">

<div class="header">

<div class="logo gradient-text">
  🚀 Deploy Website
</div>

<div class="subtitle">
  নতুন website deploy করুন
</div>

</div>

<div class="top-nav">

<a class="nav-btn" href="/">
  🏠 Dashboard
</a>

<a class="nav-btn" href="/projects">
  📂 Project View
</a>

</div>


<div class="card rgb-card">

<h2 class="gradient-text">
  🚀 নতুন Project Deploy করুন
</h2>

<form
  id="deployForm"
  action="/deploy"
  method="POST"
  enctype="multipart/form-data"
>

<label>
  Project Name
</label>

<input
  type="text"
  name="sitename"
  required
  placeholder="my-project"
  pattern="[A-Za-z0-9_-]+"
  maxlength="50"
>

<p class="help">
শুধু English letters, numbers,
- এবং _ ব্যবহার করুন।
</p>


<label>
  Website Files
</label>

<div
  id="dropBox"
  class="drop"
>

<div style="font-size:55px">
  📦
</div>

<div
style="font-size:19px;font-weight:900;margin:10px 0"
>
HTML / CSS / JS অথবা ZIP
</div>

<div class="help">
Drag & Drop অথবা file select করুন
</div>

<br>

<input
  type="file"
  id="fileInput"
  name="projectfiles"
  multiple
  required
  accept="
  .html,.htm,.css,.js,.json,
  .png,.jpg,.jpeg,.gif,.svg,
  .webp,.ico,.txt,.zip
  "
>

<div
id="fileStatus"
class="help"
style="margin-top:10px"
>
কোনো file নির্বাচন করা হয়নি
</div>

</div>


<button
id="deployBtn"
class="deploy-btn"
type="submit"
>
🚀 DEPLOY WEBSITE
</button>

</form>

</div>


<div class="card">

<h2>
  ℹ️ Deploy Information
</h2>

<div class="help">

• HTML / CSS / JS আলাদা আলাদা upload করতে পারবেন।<br>

• ZIP file upload করলে automatically extract হবে।<br>

• ZIP-এর ভিতরে একটাই root folder থাকলেও automatically flatten হবে।<br>

• index.html না থাকলে প্রথম পাওয়া HTML file দিয়ে index.html তৈরি হবে।<br>

• Deploy হওয়ার পরে Project View থেকে website manage করতে পারবেন।<br>

• সর্বোচ্চ 100 MB per file এবং 50টি file upload করা যাবে।

</div>

</div>

</div>


<script>

const fileInput =
document.getElementById("fileInput");

const fileStatus =
document.getElementById("fileStatus");

const dropBox =
document.getElementById("dropBox");

function updateFileStatus(){

  if(!fileInput.files.length){

    fileStatus.textContent =
      "কোনো file নির্বাচন করা হয়নি";

    return;
  }

  const count =
    fileInput.files.length;

  fileStatus.textContent =
    "✅ " + count + "টি file selected";

  dropBox.classList.add(
    "uploading"
  );

  setTimeout(()=>{
    dropBox.classList.remove(
      "uploading"
    );
  },500);
}

fileInput.addEventListener(
  "change",
  updateFileStatus
);


dropBox.addEventListener(
  "dragover",
  event => {

    event.preventDefault();

    dropBox.style.transform =
      "scale(1.01)";

    dropBox.style.borderColor =
      "#8b5cf6";
  }
);


dropBox.addEventListener(
  "dragleave",
  () => {

    dropBox.style.transform = "";
  }
);


dropBox.addEventListener(
  "drop",
  event => {

    event.preventDefault();

    dropBox.style.transform = "";

    if(
      event.dataTransfer.files.length
    ){

      fileInput.files =
        event.dataTransfer.files;

      updateFileStatus();
    }
  }
);


const deployForm =
document.getElementById(
  "deployForm"
);

const deployBtn =
document.getElementById(
  "deployBtn"
);

deployForm.addEventListener(
  "submit",
  () => {

    deployBtn.innerHTML =
      "⏳ UPLOADING & DEPLOYING...";

    deployBtn.disabled = true;

    deployBtn.style.pointerEvents =
      "none";
  }
);

</script>

</body>
</html>
`);
});

// ======================================================
// PROJECT VIEW PAGE
// ======================================================

app.get("/projects", (req, res) => {
  const projects = getAllProjects();

  const projectHTML = projects.length
    ? projects.map(project => {

        const liveUrl =
          `/site/${encodeURIComponent(
            project.slug
          )}/`;

        return `
<div
  class="project"
  data-search="${escapeAttribute(
    `${project.title}
     ${project.name}
     ${project.slug}
     ${project.description}
     ${project.keywords}`
  )}"
>

<div class="project-info">

<div class="project-title">
  🌐 ${escapeHtml(
    project.title
  )}
</div>

<div class="project-id">
  Project ID:
  ${escapeHtml(
    project.name
  )}
</div>

<a
  class="project-url"
  href="${liveUrl}"
  target="_blank"
  rel="noopener"
>
  /site/${escapeHtml(
    project.slug
  )}/
</a>

<div class="project-description">
  ${escapeHtml(
    project.description
  )}
</div>

<div class="project-meta">

<span>
  💾 ${escapeHtml(
    project.size
  )} KB
</span>

<span style="color:#4ade80">
  ● Live
</span>

</div>

</div>


<div class="actions">

<a
  class="action live"
  href="${liveUrl}"
  target="_blank"
  rel="noopener"
>
🌐 Live
</a>

<a
  class="action edit"
  href="/edit/${encodeURIComponent(
    project.name
  )}"
>
✏️ Edit
</a>

<button
  class="action copy"
  type="button"
  data-url="${liveUrl}"
>
📋 Copy
</button>

<form
  action="/delete/${encodeURIComponent(
    project.name
  )}"
  method="POST"
  onsubmit="return confirm('এই project delete করতে চান?')"
>

<button
  class="action delete"
  type="submit"
>
🗑 Delete
</button>

</form>

</div>

</div>
`;

      }).join("")
    : `
<div class="empty">

<div class="empty-icon">
  📂
</div>

<b>
এখনো কোনো project deploy করা হয়নি।
</b>

<p>
Deploy page থেকে আপনার প্রথম website
deploy করুন।
</p>

<a
  class="nav-btn"
  href="/deploy-page"
>
🚀 DEPLOY WEBSITE
</a>

</div>
`;


  res.send(`
<!DOCTYPE html>
<html lang="bn">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>Project View - TM</title>

<style>
${sharedCSS}
</style>

</head>

<body>

<div class="container">

<div class="header">

<div class="logo gradient-text">
  📂 Project View
</div>

<div class="subtitle">
  আপনার সব deployed website
</div>

</div>


<div class="top-nav">

<a
class="nav-btn"
href="/"
>
🏠 Dashboard
</a>

<a
class="nav-btn"
href="/deploy-page"
>
🚀 Deploy Website
</a>

</div>


<div class="card rgb-card">

<div
style="
display:flex;
justify-content:space-between;
align-items:center;
gap:15px;
flex-wrap:wrap;
"
>

<h2
class="gradient-text"
style="margin-bottom:0"
>
📂 My Projects
</h2>

<div
style="
color:#94a3b8;
font-size:13px;
"
>
${projects.length}
Project${projects.length !== 1 ? "s" : ""}
</div>

</div>

<br>

<input
id="projectSearch"
class="search"
type="text"
placeholder="🔍 Project / URL খুঁজুন..."
>

<div id="projectsList">

${projectHTML}

</div>

<div
id="noResult"
class="empty"
style="display:none"
>

<div class="empty-icon">
  🔎
</div>

<b>
কোনো matching project পাওয়া যায়নি।
</b>

</div>

</div>

</div>


<div id="toast" class="toast">
  🔗 URL copied!
</div>


<script>

const search =
document.getElementById(
  "projectSearch"
);

const noResult =
document.getElementById(
  "noResult"
);

search.addEventListener(
  "input",
  () => {

    const query =
      search.value
        .trim()
        .toLowerCase();

    const projects =
      [
        ...document.querySelectorAll(
          ".project"
        )
      ];

    let visible = 0;

    projects.forEach(project => {

      const text =
        (
          project.dataset.search ||
          ""
        ).toLowerCase();

      const match =
        !query ||
        text.includes(query);

      project.style.display =
        match ? "flex" : "none";

      if(match){
        visible++;
      }
    });

    noResult.style.display =
      visible
        ? "none"
        : "block";
  }
);


function showToast(message){

  const toast =
    document.getElementById(
      "toast"
    );

  toast.textContent =
    message;

  toast.classList.add(
    "show"
  );

  clearTimeout(
    window.tmToast
  );

  window.tmToast =
    setTimeout(() => {

      toast.classList.remove(
        "show"
      );

    },1800);
}


document
.querySelectorAll(".copy")
.forEach(button => {

  button.addEventListener(
    "click",
    async () => {

      const relative =
        button.dataset.url;

      const fullUrl =
        new URL(
          relative,
          window.location.origin
        ).href;

      try{

        await navigator
          .clipboard
          .writeText(
            fullUrl
          );

        button.textContent =
          "✅ Copied";

        showToast(
          "🔗 Website URL copied!"
        );

      }catch{

        const area =
          document.createElement(
            "textarea"
          );

        area.value =
          fullUrl;

        document.body.appendChild(
          area
        );

        area.select();

        document.execCommand(
          "copy"
        );

        area.remove();

        button.textContent =
          "✅ Copied";

        showToast(
          "🔗 Website URL copied!"
        );
      }

      setTimeout(() => {

        button.textContent =
          "📋 Copy";

      },1600);
    }
  );

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
  upload.array(
    "projectfiles",
    50
  ),

  async (req, res) => {

    const siteName =
      sanitizeSiteName(
        req.body.sitename
      );

    const files =
      req.files || [];

    if(!siteName){
      return res
        .status(400)
        .send(
          "Invalid project name."
        );
    }

    if(!files.length){
      return res
        .status(400)
        .send(
          "কোনো file পাওয়া যায়নি।"
        );
    }

    const targetDir =
      safeJoin(
        sitesDir,
        siteName
      );

    try{

      await fs.remove(
        targetDir
      );

      await fs.ensureDir(
        targetDir
      );


      // ==================================================
      // ZIP
      // ==================================================

      if(
        files.length === 1 &&
        path
          .extname(
            files[0].originalname
          )
          .toLowerCase() === ".zip"
      ){

        const zip =
          new AdmZip(
            files[0].path
          );

        const entries =
          zip.getEntries();

        for(
          const entry of entries
        ){

          if(entry.isDirectory){
            continue;
          }

          let entryName =
            entry.entryName
              .replace(
                /\\/g,
                "/"
              );

          entryName =
            entryName
              .replace(
                /^\/+/,
                ""
              )
              .replace(
                /^(\.\.\/)+/,
                ""
              );

          if(!entryName){
            continue;
          }

          const outputPath =
            safeJoin(
              targetDir,
              entryName
            );

          await fs.ensureDir(
            path.dirname(
              outputPath
            )
          );

          fs.writeFileSync(
            outputPath,
            entry.getData()
          );
        }

        await fs.remove(
          files[0].path
        );

        await flattenSingleFolder(
          targetDir
        );

      }

      // ==================================================
      // MULTIPLE FILES
      // ==================================================

      else{

        for(
          const file of files
        ){

          const safeName =
            sanitizeFileName(
              file.originalname
            );

          const destination =
            safeJoin(
              targetDir,
              safeName
            );

          await fs.move(
            file.path,
            destination,
            {
              overwrite:true
            }
          );
        }
      }


      // ==================================================
      // AUTOMATIC INDEX
      // ==================================================

      const indexFile =
        await ensureIndexHtml(
          targetDir
        );

      if(!indexFile){

        return res.send(`
<!DOCTYPE html>
<html>

<head>
<meta charset="UTF-8">
<title>No HTML Found</title>
</head>

<body
style="
background:#020617;
color:white;
font-family:Arial;
text-align:center;
padding-top:100px;
"
>

<h1>
⚠️ Deploy হয়েছে
</h1>

<p>
কিন্তু কোনো HTML file পাওয়া যায়নি।
</p>

<a
href="/"
style="color:#38bdf8"
>
← Dashboard
</a>

</body>
</html>
`);
      }


      // ==================================================
      // METADATA
      // ==================================================

      ensureProjectMetadata(
        siteName
      );

      const meta =
        getProjectMetadata(
          siteName
        );

      const currentSlug =
        meta.slug || siteName;


      // ==================================================
      // SUCCESS
      // ==================================================

      const liveUrl =
        getProjectUrl(
          req,
          currentSlug
        );

      res.send(`
<!DOCTYPE html>
<html lang="bn">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
Deployment Successful
</title>

<style>

body{
margin:0;
background:
radial-gradient(
circle at top,
#172554,
#020617
);
color:white;
font-family:Arial;
display:flex;
justify-content:center;
align-items:center;
min-height:100vh;
}

.box{
width:min(620px,90%);
background:rgba(15,23,42,.94);
border:1px solid #334155;
border-radius:22px;
padding:40px;
text-align:center;
box-shadow:
0 0 50px
rgba(56,189,248,.25);
}

.success{
font-size:65px;
}

h1{
color:#4ade80;
}

.url{
display:block;
margin:25px 0;
padding:15px;
background:#020617;
border:1px solid #38bdf8;
border-radius:10px;
color:#38bdf8;
word-break:break-all;
text-decoration:none;
}

.btn{
display:inline-block;
padding:13px 20px;
background:#334155;
color:white;
border-radius:10px;
text-decoration:none;
margin:5px;
}

.live{
background:#059669;
}

</style>

</head>

<body>

<div class="box">

<div class="success">
🎉
</div>

<h1>
Deployment Successful!
</h1>

<p>
<b>
${escapeHtml(
  siteName
)}
</b>
সফলভাবে deploy হয়েছে।
</p>

<a
class="url"
href="${escapeAttribute(
  liveUrl
)}"
target="_blank"
>
${escapeHtml(
  liveUrl
)}
</a>

<a
class="btn live"
href="${escapeAttribute(
  liveUrl
)}"
target="_blank"
>
🌐 OPEN WEBSITE
</a>

<a
class="btn"
href="/projects"
>
📂 PROJECT VIEW
</a>

<a
class="btn"
href="/"
>
← DASHBOARD
</a>

</div>

</body>
</html>
`);

    }catch(error){

      console.error(
        "DEPLOY ERROR:",
        error
      );

      for(
        const file of files
      ){

        try{
          await fs.remove(
            file.path
          );
        }catch{}

      }

      res
        .status(500)
        .send(`
<h1
style="
text-align:center;
margin-top:100px;
font-family:Arial;
color:red
"
>
❌ Deployment Failed
</h1>

<p
style="
text-align:center;
font-family:Arial
"
>
File process করতে সমস্যা হয়েছে।
</p>

<p
style="text-align:center"
>
<a href="/">
← Dashboard
</a>
</p>
`);
    }
  }
);

// ======================================================
// EDIT PROJECT PAGE
// ======================================================

app.get(
  "/edit/:project",
  (req, res) => {

    const folderName =
      sanitizeSiteName(
        req.params.project
      );

    const projectDir =
      safeJoin(
        sitesDir,
        folderName
      );

    if(
      !fs.existsSync(
        projectDir
      )
    ){

      return res
        .status(404)
        .send(
          "Project not found."
        );
    }

    ensureProjectMetadata(
      folderName
    );

    const meta =
      getProjectMetadata(
        folderName
      );

    res.send(`
<!DOCTYPE html>
<html lang="bn">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
Edit ${escapeHtml(
  meta.title
)}
</title>

<style>
${sharedCSS}
</style>

</head>

<body>

<div class="container">

<div class="header">

<div class="logo gradient-text">
  ✏️ Edit Website
</div>

<div class="subtitle">
  ${escapeHtml(
    meta.title
  )}
</div>

</div>


<div class="top-nav">

<a
class="nav-btn"
href="/"
>
🏠 Dashboard
</a>

<a
class="nav-btn"
href="/projects"
>
📂 Project View
</a>

<a
class="nav-btn"
href="/deploy-page"
>
🚀 Deploy
</a>

</div>


<div class="card rgb-card">

<h2 class="gradient-text">
  🔄 Update Website
</h2>

<p class="help">

এখানে নতুন HTML / CSS / JS অথবা ZIP
দিলে এই একই project-এর files replace হবে।

নতুন project তৈরি হবে না।

</p>


<form
action="/update/${encodeURIComponent(
  folderName
)}"
method="POST"
enctype="multipart/form-data"
>

<label>
Website Files
</label>

<input
type="file"
name="projectfiles"
multiple
required
accept="
.html,.htm,.css,.js,.json,
.png,.jpg,.jpeg,.gif,.svg,
.webp,.ico,.txt,.zip
"
>

<button
class="primary-btn"
type="submit"
>
🔄 UPDATE WEBSITE
</button>

</form>

</div>


<div class="card">

<h2>
🔗 Custom URL
</h2>

<p class="help">

URL-এর শেষের নাম পরিবর্তন করতে পারবেন।

যেমন:

/site/tmclock/

→

/site/tm-clock/

</p>


<form
action="/save-settings/${encodeURIComponent(
  folderName
)}"
method="POST"
>

<label>
Public URL Name
</label>

<input
id="slugInput"
type="text"
name="slug"
value="${escapeAttribute(
  meta.slug ||
  folderName
)}"
required
pattern="[A-Za-z0-9_-]+"
maxlength="50"
>

<div class="url-preview">

/site/

<b id="slugPreview">
${escapeHtml(
  meta.slug ||
  folderName
)}
</b>

/

</div>


<h2>
🔎 Google / SEO Settings
</h2>


<label>
Website Title
</label>

<input
type="text"
name="title"
value="${escapeAttribute(
  meta.title || ""
)}"
placeholder="TM Clock"
maxlength="150"
>


<label>
Description
</label>

<textarea
name="description"
maxlength="300"
placeholder="TM Clock - Online Digital Clock"
>${escapeHtml(
  meta.description || ""
)}</textarea>


<label>
Keywords
</label>

<input
type="text"
name="keywords"
value="${escapeAttribute(
  meta.keywords || ""
)}"
placeholder="TM Clock, Digital Clock, Online Clock"
maxlength="500"
>


<label>
Author
</label>

<input
type="text"
name="author"
value="${escapeAttribute(
  meta.author ||
  "Tamim Khan"
)}"
maxlength="100"
>


<p class="help">

💡 SEO information Google search engine-কে
website সম্পর্কে বুঝতে সাহায্য করবে।

Sitemap এবং robots.txt automatically তৈরি হচ্ছে।

</p>


<button
class="primary-btn"
type="submit"
>
💾 SAVE URL + SEO
</button>

</form>

</div>

</div>


<script>

const slugInput =
document.getElementById(
  "slugInput"
);

const slugPreview =
document.getElementById(
  "slugPreview"
);

slugInput.addEventListener(
  "input",
  () => {

    slugPreview.textContent =
      slugInput.value ||
      "your-site";

  }
);

</script>

</body>
</html>
`);
  }
);

// ======================================================
// UPDATE EXISTING PROJECT
// ======================================================

app.post(
  "/update/:project",

  upload.array(
    "projectfiles",
    50
  ),

  async (req, res) => {

    const folderName =
      sanitizeSiteName(
        req.params.project
      );

    const files =
      req.files || [];

    const targetDir =
      safeJoin(
        sitesDir,
        folderName
      );

    if(
      !fs.existsSync(
        targetDir
      )
    ){

      return res
        .status(404)
        .send(
          "Project not found."
        );
    }

    if(!files.length){

      return res
        .status(400)
        .send(
          "কোনো file পাওয়া যায়নি।"
        );
    }

    try{

      const updateDir =
        path.join(
          DATA_DIR,
          `update-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`
        );

      await fs.ensureDir(
        updateDir
      );


      // ==================================================
      // ZIP
      // ==================================================

      if(
        files.length === 1 &&
        path
          .extname(
            files[0].originalname
          )
          .toLowerCase() === ".zip"
      ){

        const zip =
          new AdmZip(
            files[0].path
          );

        const entries =
          zip.getEntries();

        for(
          const entry of entries
        ){

          if(entry.isDirectory){
            continue;
          }

          let entryName =
            entry.entryName
              .replace(
                /\\/g,
                "/"
              );

          entryName =
            entryName
              .replace(
                /^\/+/,
                ""
              )
              .replace(
                /^(\.\.\/)+/,
                ""
              );

          if(!entryName){
            continue;
          }

          const outputPath =
            safeJoin(
              updateDir,
              entryName
            );

          await fs.ensureDir(
            path.dirname(
              outputPath
            )
          );

          fs.writeFileSync(
            outputPath,
            entry.getData()
          );
        }

        await fs.remove(
          files[0].path
        );

        await flattenSingleFolder(
          updateDir
        );

      }

      // ==================================================
      // MULTIPLE FILES
      // ==================================================

      else{

        for(
          const file of files
        ){

          const safeName =
            sanitizeFileName(
              file.originalname
            );

          const destination =
            safeJoin(
              updateDir,
              safeName
            );

          await fs.move(
            file.path,
            destination,
            {
              overwrite:true
            }
          );
        }
      }


      // ==================================================
      // AUTOMATIC INDEX
      // ==================================================

      const indexFile =
        await ensureIndexHtml(
          updateDir
        );

      if(!indexFile){

        await fs.remove(
          updateDir
        );

        return res
          .status(400)
          .send(`
<h2
style="
text-align:center;
margin-top:100px
"
>
⚠️ Update failed
</h2>

<p
style="text-align:center"
>
নতুন files-এর মধ্যে কোনো HTML পাওয়া যায়নি।
</p>

<p
style="text-align:center"
>

<a
href="/edit/${encodeURIComponent(
  folderName
)}"
>
← Back
</a>

</p>
`);
      }


      // ==================================================
      // BACKUP CURRENT WEBSITE
      // ==================================================

      const backupDir =
        path.join(
          DATA_DIR,
          `backup-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`
        );

      await fs.move(
        targetDir,
        backupDir
      );

      try{

        await fs.move(
          updateDir,
          targetDir
        );

        await fs.remove(
          backupDir
        );

      }catch(replaceError){

        console.error(
          "Update replace error:",
          replaceError
        );

        await fs.remove(
          targetDir
        );

        await fs.move(
          backupDir,
          targetDir
        );

        throw replaceError;
      }


      const meta =
        getProjectMetadata(
          folderName
        );

      const liveSlug =
        meta.slug ||
        folderName;

      const liveUrl =
        getProjectUrl(
          req,
          liveSlug
        );


      res.send(`
<!DOCTYPE html>
<html>

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
Website Updated
</title>

<style>

body{
margin:0;
min-height:100vh;
display:flex;
justify-content:center;
align-items:center;
font-family:Arial;
color:white;
background:
radial-gradient(
circle at top,
#172554,
#020617
);
}

.box{
width:min(620px,90%);
padding:40px;
text-align:center;
background:rgba(15,23,42,.95);
border:1px solid #334155;
border-radius:22px;
box-shadow:
0 0 50px
rgba(56,189,248,.2);
}

.ok{
font-size:60px;
}

a{
display:inline-block;
padding:14px 20px;
margin:7px;
border-radius:10px;
background:#059669;
color:white;
text-decoration:none;
font-weight:bold;
}

.back{
background:#334155;
}

.url{
display:block;
background:#020617;
border:1px solid #38bdf8;
color:#38bdf8;
padding:13px;
border-radius:10px;
word-break:break-all;
}

</style>

</head>

<body>

<div class="box">

<div class="ok">
✅
</div>

<h1>
Website Updated!
</h1>

<p>
<b>
${escapeHtml(
  folderName
)}
</b>
এর website successfully update হয়েছে।
</p>

<p>
একই URL-এই নতুন version চলছে।
</p>

<a
class="url"
href="${escapeAttribute(
  liveUrl
)}"
target="_blank"
>
${escapeHtml(
  liveUrl
)}
</a>

<a
href="${escapeAttribute(
  liveUrl
)}"
target="_blank"
>
🌐 OPEN WEBSITE
</a>

<a
href="/projects"
class="back"
>
📂 PROJECT VIEW
</a>

<a
href="/"
class="back"
>
← DASHBOARD
</a>

</div>

</body>
</html>
`);

    }catch(error){

      console.error(
        "UPDATE ERROR:",
        error
      );

      for(
        const file of files
      ){

        try{
          await fs.remove(
            file.path
          );
        }catch{}

      }

      res
        .status(500)
        .send(`
<h2
style="
text-align:center;
margin-top:100px;
font-family:Arial;
color:red
"
>
❌ Website Update Failed
</h2>

<p
style="text-align:center"
>
<a
href="/edit/${encodeURIComponent(
  folderName
)}"
>
← Back
</a>
</p>
`);
    }
  }
);

// ======================================================
// SAVE URL + SEO SETTINGS
// ======================================================

app.post(
  "/save-settings/:project",

  async (req, res) => {

    try{

      const folderName =
        sanitizeSiteName(
          req.params.project
        );

      const projectDir =
        safeJoin(
          sitesDir,
          folderName
        );

      if(
        !fs.existsSync(
          projectDir
        )
      ){

        return res
          .status(404)
          .send(
            "Project not found."
          );
      }

      const newSlug =
        sanitizeSiteName(
          req.body.slug
        );

      if(!newSlug){

        return res
          .status(400)
          .send(
            "Invalid URL name."
          );
      }


      // ==================================================
      // CHECK SLUG CONFLICT
      // ==================================================

      const existing =
        findProjectBySlug(
          newSlug
        );

      if(
        existing &&
        existing.folderName !==
          folderName
      ){

        return res
          .status(400)
          .send(`
<h2
style="
text-align:center;
margin-top:100px;
font-family:Arial;
color:red
"
>
❌ এই URL name আগে থেকেই ব্যবহার করা হয়েছে।
</h2>

<p
style="text-align:center"
>
<a
href="/edit/${encodeURIComponent(
  folderName
)}"
>
← Back
</a>
</p>
`);
      }


      const oldMeta =
        getProjectMetadata(
          folderName
        );

      const oldSlug =
        oldMeta.slug ||
        folderName;


      let previousSlugs =
        Array.isArray(
          oldMeta.previousSlugs
        )
          ? oldMeta.previousSlugs
          : [];


      if(
        oldSlug !== newSlug &&
        !previousSlugs.includes(
          oldSlug
        )
      ){

        previousSlugs.push(
          oldSlug
        );
      }


      previousSlugs =
        previousSlugs.slice(-10);


      setProjectMetadata(
        folderName,
        {
          slug:newSlug,

          title:String(
            req.body.title ||
            oldMeta.title ||
            folderName
          ).slice(0,150),

          description:String(
            req.body.description ||
            oldMeta.description ||
            ""
          ).slice(0,300),

          keywords:String(
            req.body.keywords ||
            oldMeta.keywords ||
            ""
          ).slice(0,500),

          author:String(
            req.body.author ||
            oldMeta.author ||
            "Tamim Khan"
          ).slice(0,100),

          previousSlugs
        }
      );


      res.redirect(
        `/edit/${encodeURIComponent(
          folderName
        )}`
      );

    }catch(error){

      console.error(
        "SETTINGS ERROR:",
        error
      );

      res
        .status(500)
        .send(
          "Settings save করতে সমস্যা হয়েছে।"
        );
    }
  }
);

// ======================================================
// DELETE PROJECT
// ======================================================

app.post(
  "/delete/:sitename",

  async (req, res) => {

    try{

      const siteName =
        sanitizeSiteName(
          req.params.sitename
        );

      if(!siteName){

        return res
          .status(400)
          .send(
            "Invalid project."
          );
      }

      const targetDir =
        safeJoin(
          sitesDir,
          siteName
        );

      await fs.remove(
        targetDir
      );


      const metadata =
        loadMetadata();

      delete metadata[
        siteName
      ];

      saveMetadata(
        metadata
      );


      res.redirect(
        "/projects"
      );

    }catch(error){

      console.error(
        error
      );

      res
        .status(500)
        .send(
          "Project delete করতে সমস্যা হয়েছে।"
        );
    }
  }
);

// ======================================================
// ROBOTS.TXT
// ======================================================

app.get(
  "/robots.txt",

  (req, res) => {

    const sitemapUrl =
      `${req.protocol}://${req.get("host")}/sitemap.xml`;

    res.type(
      "text/plain"
    );

    res.send(
`User-agent: *
Allow: /

Sitemap: ${sitemapUrl}
`
    );
  }
);

// ======================================================
// SITEMAP.XML
// ======================================================

app.get(
  "/sitemap.xml",

  (req, res) => {

    const metadata =
      loadMetadata();

    let urls = [];

    try{

      const folders =
        fs.readdirSync(
          sitesDir,
          {
            withFileTypes:true
          }
        )
        .filter(
          item =>
            item.isDirectory()
        );

      urls =
        folders.map(
          folder => {

            const meta =
              metadata[
                folder.name
              ] || {
                slug:folder.name
              };

            return (
              meta.slug ||
              folder.name
            );
          }
        );

    }catch(error){

      console.error(
        "Sitemap error:",
        error
      );
    }


    const base =
      `${req.protocol}://${req.get("host")}`;


    const entries =
      urls
        .map(
          slug => `
  <url>
    <loc>${escapeHtml(
      `${base}/site/${encodeURIComponent(
        slug
      )}/`
    )}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`
        )
        .join("");


    res.type(
      "application/xml"
    );

    res.send(`
<?xml version="1.0" encoding="UTF-8"?>

<urlset
xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
>

<url>

<loc>
${escapeHtml(
  base + "/"
)}
</loc>

<changefreq>
daily
</changefreq>

<priority>
1.0
</priority>

</url>

${entries}

</urlset>
`);
  }
);

// ======================================================
// LIVE WEBSITE
// ======================================================

app.use(
  "/site/:sitename",

  async (req, res, next) => {

    try{

      const requestedSlug =
        sanitizeSiteName(
          req.params.sitename
        );

      if(!requestedSlug){

        return res
          .status(404)
          .send(
            "Project not found."
          );
      }


      const project =
        findProjectBySlug(
          requestedSlug
        );

      if(!project){

        return res
          .status(404)
          .send(`
<h1
style="
text-align:center;
margin-top:100px;
font-family:Arial
"
>
404 - Project Not Found
</h1>
`);
      }


      const folderName =
        project.folderName;


      const meta =
        getProjectMetadata(
          folderName
        );


      const sitePath =
        safeJoin(
          sitesDir,
          folderName
        );


      // ==================================================
      // OLD URL → NEW URL
      // ==================================================

      if(
        meta.slug &&
        meta.slug !== requestedSlug
      ){

        const newUrl =
          `/site/${encodeURIComponent(
            meta.slug
          )}${
            req.path === "/"
              ? "/"
              : req.path
          }`;

        return res.redirect(
          301,
          newUrl
        );
      }


      // ==================================================
      // /site/project/
      // ==================================================

      if(
        req.path === "/" ||
        req.path === ""
      ){

        let indexFile =
          path.join(
            sitePath,
            "index.html"
          );


        if(
          !fs.existsSync(
            indexFile
          )
        ){

          indexFile =
            findBestHtml(
              sitePath
            );
        }


        if(indexFile){

          const liveUrl =
            getProjectUrl(
              req,
              meta.slug ||
              folderName
            );


          try{

            const html =
              await fs.readFile(
                indexFile,
                "utf8"
              );


            const seoHtml =
              injectSEO(
                html,
                meta,
                liveUrl
              );


            return res
              .type("html")
              .send(
                seoHtml
              );

          }catch{

            return res.sendFile(
              indexFile
            );
          }
        }


        return res
          .status(404)
          .send(`
<div
style="
font-family:Arial;
text-align:center;
margin-top:100px
"
>

<h2>
⚠️ No HTML file found
</h2>

<p>
এই project-এ কোনো HTML file নেই।
</p>

</div>
`);
      }


      // ==================================================
      // STATIC FILES
      // ==================================================

      express.static(
        sitePath,
        {
          index:"index.html",
          fallthrough:true,
          maxAge:"1h"
        }
      )(req,res,next);

    }catch(error){

      console.error(
        "SITE ERROR:",
        error
      );

      next(error);
    }
  }
);

// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
  (err, req, res, next) => {

    console.error(
      err
    );

    res
      .status(500)
      .send(`
<h2
style="
text-align:center;
font-family:Arial
"
>
Server Error
</h2>
`);
  }
);

// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `🚀 Server running on port ${PORT}`
    );

    console.log(
      `📁 Sites directory: ${sitesDir}`
    );

    console.log(
      `📝 Metadata file: ${metadataFile}`
    );

  }
);
