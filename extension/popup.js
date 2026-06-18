const API_URL = "http://127.0.0.1:19827";
const PAIRING_STORAGE_KEY = "clipPairingCode";

const statusBar = document.getElementById("statusBar");
const titleInput = document.getElementById("titleInput");
const urlPreview = document.getElementById("urlPreview");
const contentPreview = document.getElementById("contentPreview");
const clipBtn = document.getElementById("clipBtn");
const projectSelect = document.getElementById("projectSelect");
const pairingInput = document.getElementById("pairingInput");
const pairingField = document.getElementById("pairingField");

let extractedContent = "";
let pageUrl = "";
let clipToken = "";
let pairingCode = "";

function storageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => resolve(result[key]));
  });
}

function storageSet(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

async function loadPairingCode() {
  const stored = await storageGet(PAIRING_STORAGE_KEY);
  if (typeof stored === "string" && stored.trim()) {
    pairingCode = stored.trim();
    if (pairingInput) pairingInput.value = pairingCode;
    if (pairingField) pairingField.style.display = "none";
    return pairingCode;
  }
  if (pairingField) pairingField.style.display = "block";
  return "";
}

async function savePairingCode(code) {
  pairingCode = code.trim();
  await storageSet(PAIRING_STORAGE_KEY, pairingCode);
  if (pairingField) pairingField.style.display = pairingCode ? "none" : "block";
}

async function fetchClipToken() {
  if (!pairingCode) {
    clipToken = "";
    return false;
  }
  try {
    const res = await fetch(`${API_URL}/clip-token`, {
      method: "GET",
      headers: { "X-Clip-Pairing": pairingCode },
    });
    const data = await res.json();
    if (data.ok && data.token) {
      clipToken = data.token;
      return true;
    }
  } catch {}
  clipToken = "";
  return false;
}

function authHeaders(extra = {}) {
  return {
    ...extra,
    ...(clipToken ? { "X-Clip-Token": clipToken } : {}),
  };
}

async function checkConnection() {
  await loadPairingCode();
  try {
    const res = await fetch(`${API_URL}/status`, { method: "GET" });
    const data = await res.json();
    if (data.ok) {
      if (!pairingCode) {
        statusBar.className = "status disconnected";
        statusBar.textContent = "✗ Enter pairing code from LLM Wiki Settings";
        clipBtn.disabled = true;
        projectSelect.innerHTML = '<option value="">Pairing required</option>';
        return false;
      }
      const authed = await fetchClipToken();
      if (!authed) {
        statusBar.className = "status error";
        statusBar.textContent = "✗ Invalid pairing code — check Settings";
        clipBtn.disabled = true;
        if (pairingField) pairingField.style.display = "block";
        return false;
      }
      statusBar.className = "status connected";
      statusBar.textContent = "✓ Connected to LLM Wiki";
      const hasProjects = await refreshProjectsUntilReady();
      if (!hasProjects) {
        statusBar.className = "status error";
        statusBar.textContent = "✓ Connected — open a wiki in the app, then reopen this popup";
      }
      return hasProjects;
    }
  } catch {}
  statusBar.className = "status disconnected";
  statusBar.textContent = "✗ LLM Wiki app is not running";
  clipBtn.disabled = true;
  projectSelect.innerHTML = '<option value="">App not running</option>';
  return false;
}

async function loadProjects() {
  try {
    const res = await fetch(`${API_URL}/projects`, {
      method: "GET",
      headers: authHeaders(),
    });
    const data = await res.json();
    if (data.ok && data.projects?.length > 0) {
      projectSelect.innerHTML = "";
      for (const proj of data.projects) {
        const opt = document.createElement("option");
        opt.value = proj.path;
        opt.textContent = proj.name + (proj.current ? " (current)" : "");
        if (proj.current) opt.selected = true;
        projectSelect.appendChild(opt);
      }
      clipBtn.disabled = false;
      return true;
    }
  } catch {}
  // Fallback to current project
  try {
    const res = await fetch(`${API_URL}/project`, {
      method: "GET",
      headers: authHeaders(),
    });
    const data = await res.json();
    if (data.ok && data.path) {
      const name = data.path.replace(/\\/g, "/").split("/").pop() || data.path;
      projectSelect.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = data.path;
      opt.textContent = name;
      projectSelect.appendChild(opt);
      clipBtn.disabled = false;
      return true;
    }
  } catch {}
  projectSelect.innerHTML = '<option value="">No projects — open a wiki in the app first</option>';
  clipBtn.disabled = true;
  return false;
}

async function refreshProjectsUntilReady(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const ok = await loadProjects();
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  await loadProjects();
  return false;
}

async function extractContent() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    pageUrl = tab.url || "";
    titleInput.value = tab.title || "Untitled";
    urlPreview.textContent = pageUrl;

    // First inject Readability.js and Turndown.js into the page
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["Readability.js", "Turndown.js"],
    });

    // Then extract content using them
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          // Use Readability to extract article content
          const documentClone = document.cloneNode(true);
          const reader = new window.Readability(documentClone);
          const article = reader.parse();

          if (!article || !article.content) {
            return { error: "Readability could not extract content" };
          }

          // Use Turndown to convert HTML to Markdown
          const turndown = new window.TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
            bulletListMarker: "-",
          });

          // Add table support
          turndown.addRule("tableCell", {
            filter: ["th", "td"],
            replacement: (content) => ` ${content.trim()} |`,
          });
          turndown.addRule("tableRow", {
            filter: "tr",
            replacement: (content) => `|${content}\n`,
          });
          turndown.addRule("table", {
            filter: "table",
            replacement: (content) => {
              // Add header separator after first row
              const lines = content.trim().split("\n");
              if (lines.length > 0) {
                const cols = (lines[0].match(/\|/g) || []).length - 1;
                const separator = "|" + " --- |".repeat(cols);
                lines.splice(1, 0, separator);
              }
              return "\n\n" + lines.join("\n") + "\n\n";
            },
          });

          // Remove images that are tracking pixels or tiny
          turndown.addRule("removeSmallImages", {
            filter: (node) => {
              if (node.nodeName !== "IMG") return false;
              const w = parseInt(node.getAttribute("width") || "999");
              const h = parseInt(node.getAttribute("height") || "999");
              return w < 10 || h < 10;
            },
            replacement: () => "",
          });

          const markdown = turndown.turndown(article.content);

          return {
            title: article.title,
            content: markdown,
            excerpt: article.excerpt || "",
            siteName: article.siteName || "",
            length: article.length || 0,
          };
        } catch (err) {
          return { error: err.message };
        }
      },
    });

    if (results?.[0]?.result) {
      const result = results[0].result;

      if (result.error) {
        contentPreview.textContent = `Extraction failed: ${result.error}. Falling back...`;
        await fallbackExtract(tab.id);
        return;
      }

      // Use Readability's title if better
      if (result.title && result.title.length > 5) {
        titleInput.value = result.title;
      }

      extractedContent = result.content;
      contentPreview.textContent = extractedContent;

      if (result.excerpt) {
        contentPreview.textContent = "📝 " + result.excerpt + "\n\n---\n\n" + extractedContent;
      }

      if (projectSelect.value) {
        clipBtn.disabled = false;
      }
    } else {
      await fallbackExtract(tab.id);
    }
  } catch (err) {
    contentPreview.textContent = `Error: ${err.message}`;
  }
}

// Fallback: simple DOM extraction if Readability fails
async function fallbackExtract(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clone = document.body.cloneNode(true);
      ["script", "style", "nav", "header", "footer", ".sidebar", ".ad", ".comments"]
        .forEach((sel) => clone.querySelectorAll(sel).forEach((el) => el.remove()));

      return clone.innerText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join("\n\n")
        .slice(0, 50000);
    },
  });

  if (results?.[0]?.result) {
    extractedContent = results[0].result;
    contentPreview.textContent = extractedContent;
    if (projectSelect.value) {
      clipBtn.disabled = false;
    }
  } else {
    contentPreview.textContent = "Failed to extract content";
  }
}

async function sendClip() {
  const selectedProject = projectSelect.value;
  if (!selectedProject) {
    statusBar.className = "status error";
    statusBar.textContent = "✗ Please select a project";
    return;
  }

  if (!clipToken) {
    const ok = await fetchClipToken();
    if (!ok) {
      statusBar.className = "status error";
      statusBar.textContent = "✗ Could not authenticate with LLM Wiki";
      return;
    }
  }

  clipBtn.disabled = true;
  statusBar.className = "status sending";
  statusBar.textContent = "⏳ Sending to LLM Wiki...";

  try {
    const res = await fetch(`${API_URL}/clip`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        title: titleInput.value,
        url: pageUrl,
        content: extractedContent,
        projectPath: selectedProject,
      }),
    });

    const data = await res.json();

    if (data.ok) {
      const projectName = projectSelect.options[projectSelect.selectedIndex]?.textContent || "project";
      statusBar.className = "status success";
      statusBar.textContent = `✓ Saved to ${projectName}`;
      clipBtn.textContent = "✓ Clipped!";
    } else {
      statusBar.className = "status error";
      statusBar.textContent = `✗ Error: ${data.error}`;
      clipBtn.disabled = false;
    }
  } catch (err) {
    statusBar.className = "status error";
    statusBar.textContent = `✗ Connection failed: ${err.message}`;
    clipBtn.disabled = false;
  }
}

clipBtn.addEventListener("click", sendClip);

if (pairingInput) {
  pairingInput.addEventListener("change", async () => {
    await savePairingCode(pairingInput.value);
    await checkConnection();
  });
  pairingInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      await savePairingCode(pairingInput.value);
      await checkConnection();
    }
  });
}

// Resize content preview to fill available space without causing popup scroll
function resizePreview() {
  const totalHeight = 500; // matches html/body height
  const preview = document.getElementById("contentPreview");
  if (!preview) return;

  // Calculate space used by everything except the preview
  const previewRect = preview.getBoundingClientRect();
  const bottomSpace = totalHeight - previewRect.top - 60; // 60px for button + footer
  const maxH = Math.max(100, Math.min(300, bottomSpace));
  preview.style.maxHeight = maxH + "px";
}

(async () => {
  const connected = await checkConnection();
  // Always extract content so user can preview, even if app not running
  await extractContent();
  if (!connected) {
    clipBtn.disabled = true;
    clipBtn.textContent = "📎 App not running — cannot save";
  }
  setTimeout(resizePreview, 100);
})();
