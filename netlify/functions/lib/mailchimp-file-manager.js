/**
 * Mailchimp Marketing API 3.0 — File Manager helpers.
 * Folder: "101cruise Newsletter Images" (find or create; never per-newsletter folders).
 *
 * Auth: MAILCHIMP_API_KEY (key ends with -<dc>, e.g. xxxx-us21).
 * Optional: MAILCHIMP_SERVER_PREFIX if the key has no datacenter suffix.
 * Optional: MAILCHIMP_NEWSLETTER_FOLDER_NAME to override the folder title.
 */

const DEFAULT_FOLDER_NAME = "101cruise Newsletter Images";

function assetError(message, { code = "mailchimp_error", statusCode = 502 } = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function publicErrorDetail(value, apiKey = "") {
  let text = String(value || "error");
  const key = String(apiKey || "").trim();
  if (key) {
    text = text.split(key).join("[redacted]");
    try {
      text = text.split(Buffer.from(`any:${key}`).toString("base64")).join("[redacted]");
    } catch {
      /* ignore */
    }
  }
  text = text.replace(/[a-z0-9_-]{16,}-[a-z]{2}\d+/gi, "[redacted]");
  text = text.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]");
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function getMailchimpConfig(env = process.env) {
  const apiKey = String(env.MAILCHIMP_API_KEY || "").trim();
  if (!apiKey) {
    throw assetError(
      "Mailchimp is not configured. Set MAILCHIMP_API_KEY in Netlify environment variables (Site settings → Environment variables) and in local .env. The key comes from Mailchimp → Account → Extras → API keys.",
      { code: "mailchimp_not_configured", statusCode: 503 }
    );
  }
  const fromKey = apiKey.includes("-") ? apiKey.slice(apiKey.lastIndexOf("-") + 1).trim() : "";
  const server = String(env.MAILCHIMP_SERVER_PREFIX || fromKey || "").trim();
  if (!server) {
    throw assetError(
      "Mailchimp server prefix is missing. Use an API key that ends with the datacentre (for example xxxx-us21), or set MAILCHIMP_SERVER_PREFIX.",
      { code: "mailchimp_not_configured", statusCode: 503 }
    );
  }
  const folderName = String(env.MAILCHIMP_NEWSLETTER_FOLDER_NAME || DEFAULT_FOLDER_NAME).trim() || DEFAULT_FOLDER_NAME;
  return {
    apiKey,
    server,
    folderName,
    baseUrl: `https://${server}.api.mailchimp.com/3.0`
  };
}

function authHeader(apiKey) {
  return `Basic ${Buffer.from(`any:${apiKey}`).toString("base64")}`;
}

async function mailchimpRequest(pathname, options = {}, env = process.env) {
  const config = options.config || getMailchimpConfig(env);
  const method = options.method || "GET";
  const url = `${config.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  const headers = {
    Authorization: authHeader(config.apiKey),
    Accept: "application/json",
    ...(options.body != null ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body != null ? JSON.stringify(options.body) : undefined
    });
  } catch (error) {
    throw assetError(
      `Could not reach Mailchimp (${publicErrorDetail(error.message || "network error")}). Check MAILCHIMP_API_KEY / MAILCHIMP_SERVER_PREFIX and try again.`,
      { code: "mailchimp_network", statusCode: 502 }
    );
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const detail = publicErrorDetail(
      (data && (data.detail || data.title || data.message)) || `HTTP ${response.status}`,
      config.apiKey
    );
    if (response.status === 401 || response.status === 403) {
      throw assetError(
        `Mailchimp rejected the API key (${detail}). Check MAILCHIMP_API_KEY in Netlify environment variables.`,
        { code: "mailchimp_unauthorized", statusCode: 502 }
      );
    }
    const err = assetError(`Mailchimp File Manager request failed: ${detail}`, {
      code: "mailchimp_error",
      statusCode: response.status >= 400 && response.status < 500 ? 400 : 502
    });
    err.httpStatus = response.status;
    throw err;
  }
  return data;
}

async function listAllFolders(env = process.env) {
  const folders = [];
  let offset = 0;
  const count = 100;
  for (;;) {
    const data = await mailchimpRequest(`/file-manager/folders?count=${count}&offset=${offset}`, {}, env);
    const batch = Array.isArray(data?.folders) ? data.folders : [];
    folders.push(...batch);
    if (batch.length < count) break;
    offset += count;
    if (offset > 5000) break;
  }
  return folders;
}

async function findOrCreateNewsletterFolder(env = process.env) {
  const config = getMailchimpConfig(env);
  const folders = await listAllFolders(env);
  const existing = folders.find(
    (row) => String(row?.name || "").trim() === config.folderName
  );
  if (existing?.id != null) {
    return {
      id: String(existing.id),
      name: String(existing.name || config.folderName),
      created: false
    };
  }
  const created = await mailchimpRequest(
    "/file-manager/folders",
    { method: "POST", body: { name: config.folderName } },
    env
  );
  if (created?.id == null) {
    throw assetError("Mailchimp did not return an id when creating the newsletter images folder.", {
      code: "mailchimp_folder_create_failed"
    });
  }
  return {
    id: String(created.id),
    name: String(created.name || config.folderName),
    created: true
  };
}

async function getFile(fileId, env = process.env) {
  const id = String(fileId || "").trim();
  if (!id) return null;
  try {
    return await mailchimpRequest(`/file-manager/files/${encodeURIComponent(id)}`, {}, env);
  } catch (error) {
    if (error.httpStatus === 404 || /resource not found|cannot find/i.test(error.message || "")) {
      return null;
    }
    throw error;
  }
}

function hostedFileUrl(file) {
  const url = String(file?.full_size_url || file?.url || "").trim();
  if (!url || !/^https:\/\//i.test(url)) return "";
  return url;
}

async function uploadFile({ name, buffer, folderId, mimeType }, env = process.env) {
  const filename = String(name || "").trim();
  if (!filename) {
    throw assetError("A filename is required to upload a newsletter image to Mailchimp.", {
      code: "mailchimp_upload_invalid",
      statusCode: 400
    });
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw assetError(`Cannot upload ${filename} to Mailchimp because the optimised file is empty.`, {
      code: "mailchimp_upload_invalid",
      statusCode: 400
    });
  }
  const body = {
    name: filename,
    file_data: buffer.toString("base64")
  };
  if (folderId != null && String(folderId).trim() !== "") {
    const numeric = Number(folderId);
    body.folder_id = Number.isFinite(numeric) ? numeric : folderId;
  }
  void mimeType;
  const file = await mailchimpRequest("/file-manager/files", { method: "POST", body }, env);
  const url = hostedFileUrl(file);
  if (!url) {
    throw assetError(
      `Mailchimp accepted ${filename} but did not return a hosted HTTPS URL. Export stopped so a Supabase link would not be used.`,
      { code: "mailchimp_upload_missing_url" }
    );
  }
  return {
    id: String(file.id),
    url,
    name: String(file.name || filename),
    folderId: file.folder_id != null ? String(file.folder_id) : String(folderId || ""),
    size: Number(file.size) || buffer.length
  };
}

module.exports = {
  DEFAULT_FOLDER_NAME,
  publicErrorDetail,
  getMailchimpConfig,
  mailchimpRequest,
  findOrCreateNewsletterFolder,
  getFile,
  hostedFileUrl,
  uploadFile
};
