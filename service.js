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

  console.log(
    `Automatic entry created: ${htmlFile} ->${existingIndex}`
  );

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

    console.log(
      `Detected project root folder: ${folderName}`
    );

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

// ======================================================
// PROJECT METADATA AUTO CREATE
// ======================================================

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
  const title =
    escapeHtml(meta.title || "Website");

  const description =
    escapeAttribute(meta.description || "");

  const keywords =
    escapeAttribute(meta.keywords || "");

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
<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>
<title>${title}</title>${seoTags}
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
// DASHBOARD
// ======================================================

app.get("/", (req, res) => {
  let projects = [];

  const metadata = loadMetadata();

  try {
    projects = fs
      .readdirSync(
        sitesDir,
        { withFileTypes: true }
      )
      .filter(
        item => item.isDirectory()
      )
      .map(item => {
        const projectPath =
          path.join(
            sitesDir,
            item.name
          );

        let size = 0;

        try {
          const files =
            fs.readdirSync(
              projectPath,
              { recursive: true }
            );

          for (const file of files) {
            try {
              const full =
                path.join(
                  projectPath,
                  file
                );

              const stat =
                fs.statSync(full);

              if (stat.isFile()) {
                size += stat.size;
              }
            } catch {}
          }
        } catch {}

        const meta =
          metadata[item.name] || {
            slug: item.name,
            title: item.name,
            description:
              `${item.name} website`,
            keywords: item.name,
            author: "Tamim Khan",
            previousSlugs: []
          };

        return {
          name: item.name,
          slug:
            meta.slug || item.name,
          title:
            meta.title || item.name,
          description:
            meta.description || "",
          keywords:
            meta.keywords || "",
          size:
            (size / 1024).toFixed(1)
        };
      });
  } catch {}

  const totalSize =
    projects.reduce(
      (sum, project) =>
        sum +
        Number(project.size || 0),
      0
    );

  const projectHTML =
    projects.length
      ? projects.map(
          project => `
      <div
        class="project"
        data-search="${escapeAttribute(
          `${project.title} ${project.name} ${project.slug} ${project.description} ${project.keywords}`
        )}"
      >

        <div class="project-info">

          <div class="project-topline">

            <div class="project-icon">
              🌐
            </div>

            <div>

              <div class="project-name">
                ${escapeHtml(
                  project.title
                )}
              </div>

              <div class="project-id">
                Project ID:
                ${escapeHtml(
                  project.name
                )}
              </div>

            </div>

          </div>

          <div class="project-url-row">

            <a
              class="project-url"
              href="/site/${encodeURIComponent(
                project.slug
              )}/"
              target="_blank"
              rel="noopener"
            >/site/${escapeHtml(
              project.slug
            )}/</a>

            <button
              class="copy-url"
              type="button"
              data-url="/site/${encodeURIComponent(
                project.slug
              )}/"
              title="Copy URL"
            >
              📋 Copy
            </button>

          </div>

          <div class="project-meta">

            <span>
              💾
              ${escapeHtml(
                project.size
              )}
              KB
            </span>

            <span>
              ● Live
            </span>

          </div>

        </div>

        <div class="actions">

          <a
            class="action-btn live-btn"
            href="/site/${encodeURIComponent(
              project.slug
            )}/"
            target="_blank"
            rel="noopener"
          >
            🌐 Live
          </a>

          <a
            class="action-btn edit-btn"
            href="/edit/${encodeURIComponent(
              project.name
            )}"
          >
            ✏️ Edit
          </a>

          <form
            action="/delete/${encodeURIComponent(
              project.name
            )}"
            method="POST"
            onsubmit="
              return confirm(
                'এই project delete করতে চান?'
              )
            "
          >

            <button
              class="action-btn delete-btn"
              type="submit"
            >
              🗑 Delete
            </button>

          </form>

        </div>

      </div>
    `
        ).join("")
      : `
        <div class="empty">

          <div class="empty-icon">
            📂
          </div>

          <b>
            এখনো কোনো project deploy করা হয়নি।
          </b>

          <span>
            উপরের Deploy box থেকে
            প্রথম website তৈরি করুন।
          </span>

        </div>
      `;

  res.send(`
<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#020617">
<title>TM Website Deploy</title>
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
  overflow-x:hidden;
  transition:background 1.2s ease, color 1s ease;
}
body::before, body::after{
  content:"";
  position:fixed;
  border-radius:50%;
  pointer-events:none;
  z-index:0;
}
body::before{
  width:500px; height:500px;
  top:-180px; left:-180px;
  background:radial-gradient(circle, var(--c1), transparent 65%);
  opacity:.12; filter:blur(50px);
  animation:orbMove1 10s ease-in-out infinite alternate;
}
body::after{
  width:450px; height:450px;
  bottom:-180px; right:-180px;
  background:radial-gradient(circle, var(--c3), transparent 65%);
  opacity:.10; filter:blur(55px);
  animation:orbMove2 12s ease-in-out infinite alternate;
}
@keyframes orbMove1{
  from{transform:translate3d(0,0,0) scale(1);}
  to{transform:translate3d(100px,70px,0) scale(1.15);}
}
@keyframes orbMove2{
  from{transform:translate3d(0,0,0) scale(1);}
  to{transform:translate3d(-100px,-70px,0) scale(1.2);}
}
.bg-light{
  position:fixed; width:7px; height:7px;
  border-radius:50%; background:var(--c1);
  box-shadow:0 0 12px var(--c1);
  opacity:.45; pointer-events:none;
  animation:floatLight 10s linear infinite;
  z-index:1;
}
.light1{left:8%; top:80%;}
.light2{left:85%; top:30%; animation-delay:2s;}
.light3{left:40%; top:15%; animation-delay:4s;}
.light4{left:65%; top:85%; animation-delay:6s;}
@keyframes floatLight{
  0%{transform:translate3d(0,0,0) scale(.7); opacity:.1;}
  50%{opacity:.65;}
  100%{transform:translate3d(0,-220px,0) scale(1.2); opacity:0;}
}
.container{
  position:relative; z-index:2;
  width:min(1050px, 94%); margin:auto;
  padding:38px 0 70px;
}
.header{text-align:center; margin-bottom:28px;}
.logo{
  min-height:90px; display:flex;
  justify-content:center; align-items:center;
  font-size:clamp(32px, 7vw, 58px);
  font-weight:900; letter-spacing:1px;
}
.logo-text{
  background:linear-gradient(90deg, var(--c1), var(--c2), var(--c3), var(--c1));
  background-size:300% auto;
  -webkit-background-clip:text; background-clip:text;
  color:transparent;
  animation:titleGradient 5s linear infinite;
  transition:opacity .4s ease, transform .4s ease;
}
@keyframes titleGradient{
  0%{background-position:0% center;}
  100%{background-position:300% center;}
}
.subtitle{color:var(--muted); font-size:clamp(15px, 3vw, 20px); margin-top:6px;}
.dashboard-stats{
  display:grid; grid-template-columns:repeat(3, 1fr);
  gap:13px; margin:0 0 22px;
}
.stat{
  position:relative; padding:17px 18px;
  border:1px solid rgba(255,255,255,.1);
  border-radius:16px; background:rgba(8,15,35,.75);
  backdrop-filter:blur(12px);
  box-shadow:0 12px 35px rgba(0,0,0,.18);
  overflow:hidden;
}
.stat::before{
  content:""; position:absolute;
  left:0; top:0; bottom:0; width:3px;
  background:linear-gradient(var(--c1), var(--c3));
}
.stat-icon{font-size:22px;}
.stat-number{font-size:25px; font-weight:900; margin-top:5px;}
.stat-label{font-size:12px; color:var(--muted); margin-top:2px;}
.rgb-card{position:relative;}
.rgb-card::before{
  content:""; position:absolute; inset:-2px;
  border-radius:22px;
  background:linear-gradient(90deg, #00d9ff, #0066ff, #8b5cf6, #00d9ff);
  background-size:300% 100%;
  animation:rgbMove 8s linear infinite;
  z-index:-2;
}
.rgb-card::after{
  content:""; position:absolute; inset:1px;
  border-radius:19px; background:rgba(8,15,35,.96);
  z-index:-1;
}
@keyframes rgbMove{
  0%{background-position:0% 50%;}
  100%{background-position:300% 50%;}
}
.card{
  position:relative; background:rgba(8,15,35,.88);
  border:1px solid var(--border); border-radius:20px;
  padding:27px; margin-bottom:25px;
  box-shadow:0 20px 60px rgba(0,0,0,.35);
}
.card h2{
  margin-top:0; font-size:clamp(22px, 5vw, 34px);
  background:linear-gradient(90deg, var(--c1), var(--c3));
  -webkit-background-clip:text; background-clip:text;
  color:transparent;
}
.section-head{
  display:flex; justify-content:space-between;
  align-items:center; gap:15px; margin-bottom:18px;
}
.section-head h2{margin-bottom:0;}
.search-wrap{position:relative; width:min(340px, 100%);}
.search-wrap input{padding-left:43px!important; margin:0!important;}
.search-icon{position:absolute; left:15px; top:50%; transform:translateY(-50%); color:#64748b; pointer-events:none;}
label{display:block; font-weight:bold; margin:18px 0 8px; font-size:17px; color:#dbeafe;}
.input-wrap{position:relative; padding:2px; border-radius:13px; overflow:hidden; margin-bottom:20px;}
.input-wrap::before{
  content:""; position:absolute; inset:-100%;
  background:conic-gradient(from 0deg, #00d9ff, #0066ff, #8b5cf6, #00d9ff);
  animation:rotateRGB 5s linear infinite;
}
.input-wrap input{position:relative; z-index:2;}
@keyframes rotateRGB{to{transform:rotate(360deg);}}
input[type=text], input[type=file], textarea{
  width:100%; padding:15px; border:0; outline:none;
  border-radius:11px; background:#020617; color:white; font-size:16px;
}
input[type=file]{border:1px solid rgba(255,255,255,.08);}
textarea{min-height:110px; resize:vertical;}
input[type=text]::placeholder, textarea::placeholder{color:#64748b;}
.drop{
  position:relative; border:2px dashed var(--c1);
  padding:30px 20px; text-align:center; border-radius:16px;
  margin-bottom:22px; background:rgba(2,6,23,.65);
  box-shadow:0 0 15px rgba(0,217,255,.15);
  transition:transform .25s ease, border-color .4s ease, box-shadow .4s ease;
}
.drop:hover{
  transform:translateY(-2px); border-color:var(--c3);
  box-shadow:0 0 25px rgba(139,92,246,.35);
}
.deploy-btn{
  position:relative; width:100%; border:0; padding:17px;
  border-radius:13px; color:white; font-size:18px; font-weight:900;
  cursor:pointer; overflow:hidden;
  background:linear-gradient(90deg, #0066ff, #8b5cf6, #0066ff);
  background-size:200% auto;
  box-shadow:0 0 20px rgba(0,102,255,.35);
  animation:buttonGradient 5s linear infinite;
  transition:transform .25s ease, box-shadow .25s ease, filter .25s ease;
}
.deploy-btn:hover{transform:translateY(-3px); box-shadow:0 0 30px var(--c1);}
.deploy-btn:active{transform:scale(.97);}
.deploy-btn:disabled{opacity:.7; cursor:wait;}
@keyframes buttonGradient{to{background-position:200% center;}}
.projects{display:grid; gap:15px;}
.project{
  position:relative; display:flex; justify-content:space-between;
  align-items:center; gap:18px; padding:19px; border-radius:16px;
  background:rgba(2,6,23,.75); border:1px solid rgba(255,255,255,.08);
  overflow:hidden; transition:transform .25s ease, box-shadow .25s ease, opacity .25s ease;
}
.project::before{
  content:""; position:absolute; inset:0; padding:1px; border-radius:16px;
  background:linear-gradient(90deg, var(--c1), var(--c2), var(--c3), var(--c1));
  background-size:300% auto; animation:rgbMove 7s linear infinite;
  -webkit-mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite:xor; mask-composite:exclude; pointer-events:none;
}
.project:hover{transform:translateY(-3px); box-shadow:0 0 25px rgba(0,217,255,.16);}
.project-info{min-width:0; flex:1;}
.project-topline{display:flex; align-items:center; gap:12px;}
.project-icon{
  width:43px; height:43px; border-radius:12px;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(135deg, rgba(0,217,255,.15), rgba(139,92,246,.18));
  border:1px solid rgba(0,217,255,.2); font-size:21px;
}
.project-name{font-size:19px; font-weight:800; word-break:break-word;}
.project-id{color:#64748b; font-size:12px; margin-top:3px; word-break:break-all;}
.project-url-row{display:flex; align-items:center; gap:8px; margin-top:13px;}
.project-url{color:var(--c1); font-size:14px; word-break:break-all; text-decoration:none;}
.project-url:hover{text-decoration:underline;}
.copy-url{
  flex:none; border:1px solid rgba(0,217,255,.2);
  background:rgba(0,217,255,.08); color:#bae6fd;
  padding:7px 9px; border-radius:8px; cursor:pointer; transition:.2s ease;
}
.copy-url:hover{transform:translateY(-1px); background:rgba(0,217,255,.16);}
.project-meta{display:flex; gap:13px; flex-wrap:wrap; color:#64748b; font-size:12px; margin-top:9px;}
.project-meta span:last-child{color:#4ade80;}
.actions{display:flex; gap:8px; position:relative; z-index:5; flex-wrap:wrap; justify-content:flex-end;}
.actions form{margin:0;}
.action-btn{
  display:inline-flex; align-items:center; justify-content:center;
  border:0; padding:11px 14px; border-radius:10px; color:white;
  font-weight:800; text-decoration:none; cursor:pointer;
  transition:transform .25s ease, filter .25s ease;
}
.live-btn{background:linear-gradient(135deg, #00a86b, #00d9a0);}
.edit-btn{background:linear-gradient(135deg, #2563eb, #7c3aed);}
.delete-btn{background:linear-gradient(135deg, #dc2626, #ff0055);}
.action-btn:hover{transform:translateY(-2px); filter:brightness(1.12);}
.empty{text-align:center; padding:42px 20px; color:#64748b; display:flex; flex-direction:column; gap:7px;}
.empty-icon{font-size:45px; opacity:.75;}
.note{color:#718096; font-size:13px; margin-top:-10px; margin-bottom:18px;}
.hidden-project{display:none!important;}
.toast{
  position:fixed; left:50%; bottom:24px; z-index:100;
  transform:translate(-50%, 20px); background:rgba(15,23,42,.96);
  border:1px solid rgba(0,217,255,.3); color:white; padding:12px 17px;
  border-radius:12px; box-shadow:0 10px 35px rgba(0,0,0,.4);
  opacity:0; pointer-events:none; transition:.3s ease;
}
.toast.show{opacity:1; transform:translate(-50%, 0);}
.uploading{animation:uploadShake .35s infinite alternate;}
@keyframes uploadShake{
  from{transform:translateX(-2px);}
  to{transform:translateX(2px);}
}
@media(max-width:780px){
  .section-head{align-items:stretch; flex-direction:column;}
  .search-wrap{width:100%;}
  .project{align-items:stretch; flex-direction:column;}
  .actions{justify-content:stretch;}
  .action-btn{flex:1;}
}
@media(max-width:650px){
  .container{width:92%; padding-top:25px;}
  .card{padding:20px;}
  .dashboard-stats{grid-template-columns:1fr 1fr;}
  .dashboard-stats .stat:last-child{grid-column:1/-1;}
  .logo{min-height:78px;}
  .project-url-row{align-items:flex-start;}
  .copy-url{padding:6px 8px;}
}
@media(max-width:420px){
  .dashboard-stats{grid-template-columns:1fr;}
  .dashboard-stats .stat:last-child{grid-column:auto;}
}
</style>
</head>
<body>

<div class="bg-light light1"></div>
<div class="bg-light light2"></div>
<div class="bg-light light3"></div>
<div class="bg-light light4"></div>

<div class="container">

<div class="header">
  <div class="logo">
    <div id="mainTitle" class="logo-text">🌐 TM Website Deploy</div>
  </div>
  <div class="subtitle">Upload → Deploy → Manage → Update → Live</div>
</div>

<div class="dashboard-stats">
  <div class="stat">
    <div class="stat-icon">🌐</div>
    <div class="stat-number">${projects.length}</div>
    <div class="stat-label">TOTAL PROJECTS</div>
  </div>
  <div class="stat">
    <div class="stat-icon">🟢</div>
    <div class="stat-number">${projects.length}</div>
    <div class="stat-label">LIVE WEBSITES</div>
  </div>
  <div class="stat">
    <div class="stat-icon">💾</div>
    <div class="stat-number">${totalSize.toFixed(1)} KB</div>
    <div class="stat-label">TOTAL STORAGE</div>
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
      <div style="font-size:42px; margin-bottom:10px">📦</div>
      <div style="font-size:18px; font-weight:bold">HTML / CSS / JS অথবা ZIP ফাইল নির্বাচন করুন</div>
      <div style="margin:8px 0 14px; color:#64748b; font-size:13px">Drag & Drop করেও file দেওয়া যাবে</div>
      <input type="file" id="fileInput" name="projectfiles" multiple required accept=".html, .htm, .css, .js, .json, .png, .jpg, .jpeg, .gif, .svg, .webp, .ico, .txt, .zip">
      <div id="fileStatus" style="margin-top:10px; color:#64748b; font-size:13px">কোনো file নির্বাচন করা হয়নি</div>
    </div>
    <button id="deployBtn" class="deploy-btn" type="submit">🚀 DEPLOY WEBSITE</button>
  </form>
</div>

<div class="card rgb-card">
  <div class="section-head">
    <h2>📂 My Projects</h2>
    <div class="search-wrap">
      <span class="search-icon">🔍</span>
      <input id="projectSearch" type="text" placeholder="Project / URL খুঁজুন...">
    </div>
  </div>
  <div id="projectsList" class="projects">
    ${projectHTML}
  </div>
  <div id="noSearchResult" class="empty" style="display:none">
    <div class="empty-icon">🔎</div>
    <b>কোনো matching project পাওয়া যায়নি।</b>
  </div>
</div>

</div>

<div id="toast" class="toast"></div>

<script>
const titles = [
  { text: "🌐 TM Website Deploy", colors: ["#00d9ff", "#0066ff", "#8b5cf6"] },
  { text: "👨‍💻 Developer Tamim Khan", colors: ["#8b5cf6", "#0066ff", "#00d9ff"] }
];
let titleIndex = 0;
function changeTitle(){
  const title = document.getElementById("mainTitle");
  if(!title) return;
  title.style.opacity = "0";
  title.style.transform = "translate3d(0,-10px,0)";
  setTimeout(()=>{
    titleIndex = (titleIndex + 1) % titles.length;
    const current = titles[titleIndex];
    title.textContent = current.text;
    title.style.background = "linear-gradient(90deg," + current.colors.join(",") + ")";
    title.style.backgroundSize = "300% auto";
    title.style.webkitBackgroundClip = "text";
    title.style.backgroundClip = "text";
    title.style.color = "transparent";
    title.style.opacity = "1";
    title.style.transform = "translate3d(0,0,0)";
  },350);
}
setInterval(changeTitle, 5000);

const themes = [
  { c1:"#00d9ff", c2:"#0066ff", c3:"#8b5cf6", bg1:"#020617", bg2:"#07132f" },
  { c1:"#8b5cf6", c2:"#2563eb", c3:"#00d9ff", bg1:"#050817", bg2:"#0b1635" },
  { c1:"#00c896", c2:"#00a8cc", c3:"#2563eb", bg1:"#02130f", bg2:"#061d29" },
  { c1:"#f59e0b", c2:"#ef4444", c3:"#8b5cf6", bg1:"#120b04", bg2:"#20101b" }
];
let themeIndex=0;
function changeTheme(){
  themeIndex = (themeIndex + 1) % themes.length;
  const theme = themes[themeIndex];
  const root = document.documentElement;
  root.style.setProperty("--c1", theme.c1);
  root.style.setProperty("--c2", theme.c2);
  root.style.setProperty("--c3", theme.c3);
  root.style.setProperty("--bg1", theme.bg1);
  root.style.setProperty("--bg2", theme.bg2);
}
setInterval(changeTheme, 8000);

const fileInput = document.getElementById("fileInput");
const fileStatus = document.getElementById("fileStatus");
const dropBox = document.getElementById("dropBox");

function updateFileStatus(){
  if(fileInput.files.length){
    const count = fileInput.files.length;
    fileStatus.textContent = "✅ " + count + "টি file selected";
    dropBox.classList.add("uploading");
    setTimeout(()=>{
      dropBox.classList.remove("uploading");
    },500);
  }else{
    fileStatus.textContent = "কোনো file নির্বাচন করা হয়নি";
  }
}
if(fileInput){
  fileInput.addEventListener("change", updateFileStatus);
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

if(dropBox){
  dropBox.addEventListener("dragover", event=>{
    event.preventDefault();
    dropBox.style.transform = "scale(1.01)";
    dropBox.style.borderColor = "var(--c3)";
  });
  dropBox.addEventListener("dragleave", ()=>{
    dropBox.style.transform = "";
  });
  dropBox.addEventListener("drop", event=>{
    event.preventDefault();
    dropBox.style.transform = "";
    if(event.dataTransfer.files.length){
      fileInput.files = event.dataTransfer.files;
      updateFileStatus();
    }
  });
}

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
    noSearchResult.style.display = visible ? "none" : "flex";
  });
}

function showToast(message){
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(window.tmToastTimer);
  window.tmToastTimer = setTimeout(()=>{
    toast.classList.remove("show");
  }, 1800);
}

document.querySelectorAll(".copy-url").forEach(button=>{
  button.addEventListener("click", async()=>{
    const relativeUrl = button.dataset.url || "";
    const fullUrl = new URL(relativeUrl, window.location.origin).href;
    try{
      await navigator.clipboard.writeText(fullUrl);
      button.textContent = "✅ Copied";
      showToast("🔗 Website URL copied!");
    }catch{
      const area = document.createElement("textarea");
      area.value = fullUrl;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      button.textContent = "✅ Copied";
      showToast("🔗 Website URL copied!");
    }
    setTimeout(()=>{
      button.textContent = "📋 Copy";
    }, 1600);
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

    if (!siteName) {
      return res.status(400).send("Invalid project name.");
    }
    if (!files.length) {
      return res.status(400).send("কোনো file পাওয়া যায়নি।");
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

      const indexFile = await ensureIndexHtml(targetDir);

      if (!indexFile) {
        return res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>No HTML Found</title>
</head>
<body style="background:#020617; color:white; font-family:Arial; text-align:center; padding-top:100px">
<h1>⚠️ Deploy হয়েছে</h1>
<p>কিন্তু কোনো HTML file পাওয়া যায়নি।</p>
<a href="/" style="color:#38bdf8">← Dashboard</a>
</body>
</html>
`);
      }

      ensureProjectMetadata(siteName);
      const meta = getProjectMetadata(siteName);
      const currentSlug = meta.slug || siteName;
      const liveUrl = getProjectUrl(req, currentSlug);

      res.send(`
<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deployment Successful</title>
<style>
body{
  margin:0;
  background:radial-gradient(circle at top, #172554, #020617);
  color:white;
  font-family:Arial;
  display:flex;
  justify-content:center;
  align-items:center;
  min-height:100vh;
}
.box{
  width:min(600px, 90%);
  background:rgba(15, 23, 42, .94);
  border:1px solid #334155;
  border-radius:22px;
  padding:40px;
  text-align:center;
  box-shadow:0 0 50px rgba(56, 189, 248, .25);
}
.success{
  font-size:60px;
  animation:pulse 1.5s infinite;
}
@keyframes pulse{
  50%{transform:scale(1.15);}
}
h1{color:#4ade80;}
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
.live{background:#059669;}
</style>
</head>
<body>
<div class="box">
<div class="success">🎉</div>
<h1>Deployment Successful!</h1>
<p><b>${escapeHtml(siteName)}</b> সফলভাবে deploy হয়েছে।</p>
<a class="url" href="${escapeAttribute(liveUrl)}" target="_blank">${escapeHtml(liveUrl)}</a>
<a class="btn live" href="${escapeAttribute(liveUrl)}" target="_blank">🌐 OPEN WEBSITE</a>
<a class="btn" href="/">← DASHBOARD</a>
</div>
</body>
</html>
`);
    } catch (error) {
      console.error("DEPLOY ERROR:", error);
      for (const file of files) {
        try {
          if (file.path && fs.existsSync(file.path)) {
            await fs.remove(file.path);
          }
        } catch {}
      }
      try {
        await fs.remove(targetDir);
      } catch {}

      res.status(500).send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Deploy Error</title>
</head>
<body style="background:#020617; color:white; font-family:Arial; text-align:center; padding-top:100px">
<h2 style="color:#ef4444">❌ Deploy করতে সমস্যা হয়েছে</h2>
<p>${escapeHtml(error.message)}</p>
<a href="/" style="color:#38bdf8">← Back to Dashboard</a>
</body>
</html>
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edit ${escapeHtml(meta.title)}</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  font-family:Arial, "Segoe UI", sans-serif;
  color:#f8fafc;
  background:linear-gradient(135deg, #020617, #07132f);
  padding:25px 0;
}
.container{width:min(850px, 94%); margin:auto;}
.card{
  background:rgba(15, 23, 42, .94);
  border:1px solid #334155;
  border-radius:22px;
  padding:25px;
  margin-bottom:20px;
  box-shadow:0 20px 60px rgba(0, 0, 0, .35);
}
h1{
  font-size:clamp(26px, 6vw, 42px);
  margin-top:0;
  background:linear-gradient(90deg, #00d9ff, #0066ff, #8b5cf6);
  -webkit-background-clip:text; background-clip:text; color:transparent;
}
h2{color:#dbeafe;}
label{display:block; font-weight:bold; margin:18px 0 8px;}
input, textarea{
  width:100%; padding:15px; border:1px solid #334155;
  outline:none; border-radius:12px; background:#020617; color:white; font-size:16px;
}
textarea{min-height:110px; resize:vertical;}
button, .btn{
  display:inline-block; border:0; padding:14px 20px;
  border-radius:12px; color:white; font-weight:800; font-size:16px;
  cursor:pointer; text-decoration:none; margin-top:20px;
}
.update{background:linear-gradient(90deg, #0066ff, #8b5cf6);}
.save{background:linear-gradient(90deg, #059669, #00a86b);}
.back{background:#334155;}
.help{color:#94a3b8; font-size:14px; line-height:1.7;}
.url-preview{
  padding:14px; border-radius:12px; background:#020617;
  border:1px solid #2563eb; color:#38bdf8; word-break:break-all; margin-top:10px;
}
.url-preview b{color:#fff;}
.preview-box{margin-top:10px; padding:12px; border-radius:10px; background:#07132f; color:#94a3b8; font-size:13px;}
</style>
</head>
<body>
<div class="container">
<div class="card">
<h1>✏️ Edit Website</h1>
<p>Project: <b>${escapeHtml(folderName)}</b></p>
<form action="/update/${encodeURIComponent(folderName)}" method="POST" enctype="multipart/form-data">
<h2>🔄 Update Website</h2>
<p class="help">
এখানে নতুন HTML / CSS / JS অথবা ZIP দিলে এই একই project-এর files replace হবে। নতুন project তৈরি হবে না।
</p>
<label>Website Files</label>
<input type="file" name="projectfiles" multiple required accept=".html, .htm, .css, .js, .json, .png, .jpg, .jpeg, .gif, .svg, .webp, .ico, .txt, .zip">
<button class="update" type="submit">🔄 UPDATE WEBSITE</button>
</form>
</div>

<div class="card">
<h2>🔗 Custom URL</h2>
<p class="help">এখানে URL-এর শেষের নাম পরিবর্তন করতে পারবে।<br>যেমন: /site/tmclock/ → /site/tm-clock/</p>
<form action="/save-settings/${encodeURIComponent(folderName)}" method="POST">
<label>Public URL Name</label>
<input id="slugInput" type="text" name="slug" value="${escapeAttribute(meta.slug || folderName)}" required pattern="[A-Za-z0-9_-]+" maxlength="50">
<div class="url-preview">/site/<b id="slugPreview">${escapeHtml(meta.slug || folderName)}</b>/</div>

<h2>🔎 Google / SEO Settings</h2>
<label>Website Title</label>
<input type="text" name="title" value="${escapeAttribute(meta.title || "")}" placeholder="TM Clock" maxlength="150">

<label>Description</label>
<textarea name="description" maxlength="300" placeholder="TM Clock - Online Digital Clock">${escapeHtml(meta.description || "")}</textarea>

<label>Keywords</label>
<input type="text" name="keywords" value="${escapeAttribute(meta.keywords || "")}" placeholder="TM Clock, Digital Clock, Online Clock" maxlength="500">

<label>Author</label>
<input type="text" name="author" value="${escapeAttribute(meta.author || "Tamim Khan")}" maxlength="100">

<p class="help">💡 SEO information Google search engine-কে website সম্পর্কে বুঝতে সাহায্য করবে। Sitemap এবং robots.txt-ও automatically তৈরি হচ্ছে।</p>
<button class="save" type="submit">💾 SAVE URL + SEO</button>
</form>
<br>
<a class="btn back" href="/">← DASHBOARD</a>
</div>
</div>

<script>
const slugInput = document.getElementById("slugInput");
const slugPreview = document.getElementById("slugPreview");
if(slugInput){
  slugInput.addEventListener("input", ()=>{
    slugPreview.textContent = slugInput.value || "your-site";
  });
}
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
  upload.array("projectfiles", 50),
  async (req, res) => {
    const folderName = sanitizeSiteName(req.params.project);
    const files = req.files || [];
    const targetDir = safeJoin(sitesDir, folderName);

    if (!fs.existsSync(targetDir)) {
      return res.status(404).send("Project not found.");
    }
    if (!files.length) {
      return res.status(400).send("কোনো file পাওয়া যায়নি।");
    }

    try {
      const updateDir = path.join(
        DATA_DIR,
        `update-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      await fs.ensureDir(updateDir);

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

          const outputPath = safeJoin(updateDir, entryName);
          await fs.ensureDir(path.dirname(outputPath));
          fs.writeFileSync(outputPath, entry.getData());
        }

        await fs.remove(files[0].path);
        await flattenSingleFolder(updateDir);
      } else {
        for (const file of files) {
          const safeName = sanitizeFileName(file.originalname);
          const destination = safeJoin(updateDir, safeName);
          await fs.move(file.path, destination, { overwrite: true });
        }
      }

      const indexFile = await ensureIndexHtml(updateDir);

      if (!indexFile) {
        await fs.remove(updateDir);
        return res.status(400).send(`
<h2 style="text-align:center">⚠️ Update failed</h2>
<p style="text-align:center">নতুন files-এর মধ্যে কোনো HTML পাওয়া যায়নি।</p>
<p style="text-align:center"><a href="/edit/${encodeURIComponent(folderName)}">← Back</a></p>
`);
      }

      const backupDir = path.join(
        DATA_DIR,
        `backup-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );

      await fs.move(targetDir, backupDir);

      try {
        await fs.move(updateDir, targetDir);
        await fs.remove(backupDir);
      } catch (replaceError) {
        console.error("Update replace error:", replaceError);
        await fs.remove(targetDir);
        await fs.move(backupDir, targetDir);
        throw replaceError;
      }

      const meta = getProjectMetadata(folderName);
      const liveSlug = meta.slug || folderName;
      const liveUrl = getProjectUrl(req, liveSlug);

      res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Website Updated</title>
<style>
body{
  margin:0; min-height:100vh; display:flex;
  justify-content:center; align-items:center;
  font-family:Arial; color:white;
  background:radial-gradient(circle at top, #172554, #020617);
}
.box{
  width:min(600px, 90%); padding:40px; text-align:center;
  background:rgba(15, 23, 42, .95); border:1px solid #334155;
  border-radius:22px; box-shadow:0 0 50px rgba(56, 189, 248, .2);
}
.ok{font-size:60px}
a{
  display:inline-block; padding:14px 20px; margin:7px;
  border-radius:10px; background:#059669; color:white;
  text-decoration:none; font-weight:bold;
}
.back{background:#334155}
.url{
  display:block; background:#020617; border:1px solid #38bdf8;
  color:#38bdf8; padding:13px; border-radius:10px;
  word-break:break-all; text-decoration:none;
}
</style>
</head>
<body>
<div class="box">
<div class="ok">✅</div>
<h1>Website Updated!</h1>
<p><b>${escapeHtml(folderName)}</b> এর website successfully update হয়েছে।</p>
<p>একই URL-েই নতুন version চলছে।</p>
<a class="url" href="${escapeAttribute(liveUrl)}" target="_blank">${escapeHtml(liveUrl)}</a>
<a href="${escapeAttribute(liveUrl)}" target="_blank">🌐 OPEN WEBSITE</a>
<a class="back" href="/">← DASHBOARD</a>
</div>
</body>
</html>
`);
    } catch (error) {
      console.error("UPDATE ERROR:", error);
      for (const file of files) {
        try {
          await fs.remove(file.path);
        } catch {}
      }
      res.status(500).send(`
<h2 style="text-align:center; margin-top:100px; font-family:Arial; color:red">❌ Website Update Failed</h2>
<p style="text-align:center"><a href="/edit/${encodeURIComponent(folderName)}">← Back</a></p>
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
    try {
      const folderName = sanitizeSiteName(req.params.project);
      const projectDir = safeJoin(sitesDir, folderName);

      if (!fs.existsSync(projectDir)) {
        return res.status(404).send("Project not found.");
      }

      const newSlug = sanitizeSiteName(req.body.slug);

      if (!newSlug) {
        return res.status(400).send("Invalid URL name.");
      }

      const existing = findProjectBySlug(newSlug);

      if (existing && existing.folderName !== folderName) {
        return res.status(400).send(`
<h2 style="text-align:center; margin-top:100px; font-family:Arial; color:red">
❌ এই URL name আগে থেকেই ব্যবহার করা হয়েছে।
</h2>
<p style="text-align:center"><a href="/edit/${encodeURIComponent(folderName)}">← Back</a></p>
`);
      }

      const oldMeta = getProjectMetadata(folderName);
      const oldSlug = oldMeta.slug || folderName;
      let previousSlugs = Array.isArray(oldMeta.previousSlugs) ? oldMeta.previousSlugs : [];

      if (oldSlug !== newSlug && !previousSlugs.includes(oldSlug)) {
        previousSlugs.push(oldSlug);
      }

      previousSlugs = previousSlugs.slice(-10);

      setProjectMetadata(folderName, {
        slug: newSlug,
        title: String(req.body.title || oldMeta.title || folderName).slice(0, 150),
        description: String(req.body.description || oldMeta.description || "").slice(0, 300),
        keywords: String(req.body.keywords || oldMeta.keywords || "").slice(0, 500),
        author: String(req.body.author || oldMeta.author || "Tamim Khan").slice(0, 100),
        previousSlugs
      });

      res.redirect(`/edit/${encodeURIComponent(folderName)}`);
    } catch (error) {
      console.error("SETTINGS ERROR:", error);
      res.status(500).send("Settings save করতে সমস্যা হয়েছে।");
    }
  }
);


// ======================================================
// DELETE PROJECT
// ======================================================

app.post(
  "/delete/:sitename",
  async (req, res) => {
    try {
      const siteName = sanitizeSiteName(req.params.sitename);

      if (!siteName) {
        return res.status(400).send("Invalid project.");
      }

      const targetDir = safeJoin(sitesDir, siteName);
      await fs.remove(targetDir);

      const metadata = loadMetadata();
      delete metadata[siteName];
      saveMetadata(metadata);

      res.redirect("/");
    } catch (error) {
      console.error(error);
      res.status(500).send("Project delete করতে সমস্যা হয়েছে।");
    }
  }
);


// ======================================================
// ROBOTS.TXT
// ======================================================

app.get(
  "/robots.txt",
  (req, res) => {
    const sitemapUrl = `${req.protocol}://${req.get("host")}/sitemap.xml`;
    res.type("text/plain");
    res.send(`User-agent: *
Allow: /

Sitemap: ${sitemapUrl}
`);
  }
);


// ======================================================
// SITEMAP.XML
// ======================================================

app.get(
  "/sitemap.xml",
  (req, res) => {
    const metadata = loadMetadata();
    let urls = [];

    try {
      const folders = fs
        .readdirSync(sitesDir, { withFileTypes: true })
        .filter(item => item.isDirectory());

      urls = folders.map(folder => {
        const meta = metadata[folder.name] || { slug: folder.name };
        return meta.slug || folder.name;
      });
    } catch {}

    const base = `${req.protocol}://${req.get("host")}`;
    const entries = urls
      .map(
        slug => `
  <url>
    <loc>${escapeHtml(`${base}/site/${encodeURIComponent(slug)}/`)}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
`
      )
      .join("");

    res.type("application/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${escapeHtml(base + "/")}</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
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
    try {
      const requestedSlug = sanitizeSiteName(req.params.sitename);

      if (!requestedSlug) {
        return res.status(404).send("Project not found.");
      }

      const project = findProjectBySlug(requestedSlug);

      if (!project) {
        return res.status(404).send(`
<h1 style="text-align:center; margin-top:100px; font-family:Arial">
404 - Project Not Found
</h1>
`);
      }

      const folderName = project.folderName;
      const meta = getProjectMetadata(folderName);
      const sitePath = safeJoin(sitesDir, folderName);

      if (meta.slug && meta.slug !== requestedSlug) {
        const newUrl = `/site/${encodeURIComponent(meta.slug)}${req.path === "/" ? "/" : req.path}`;
        return res.redirect(301, newUrl);
      }

      if (req.path === "/" || req.path === "") {
        let indexFile = path.join(sitePath, "index.html");

        if (!fs.existsSync(indexFile)) {
          indexFile = findBestHtml(sitePath);
        }

        if (indexFile) {
          const liveUrl = getProjectUrl(req, meta.slug || folderName);
          try {
            const html = await fs.readFile(indexFile, "utf8");
            const seoHtml = injectSEO(html, meta, liveUrl);
            return res.type("html").send(seoHtml);
          } catch {
            return res.sendFile(indexFile);
          }
        }

        return res.status(404).send(`
<div style="font-family:Arial; text-align:center; margin-top:100px">
<h2>⚠️ No HTML
