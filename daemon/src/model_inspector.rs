use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub name: String,
    pub path: String,
    pub file_size_bytes: u64,
    pub estimated_ram_mb: u64,
    pub estimated_kv_cache_mb: u64,
    pub total_required_mb: u64,
    pub quantization: String,
    pub parameter_count: String,
}

/// Derive quantization from a human-readable Ollama model/tag name.
/// Longer / more specific patterns are checked first to avoid false prefix matches.
pub fn extract_quantization_from_name(name: &str) -> String {
    let lower = name.to_lowercase();

    // Explicit GGUF-style tags embedded in the name or tag
    for (pat, label) in &[
        ("q4_k_m", "Q4_K_M"), ("q4km",   "Q4_K_M"),
        ("q4_k_s", "Q4_K_S"),
        ("q3_k_m", "Q3_K_M"), ("q3_k_s", "Q3_K_S"),
        ("q5_k_m", "Q5_K_M"), ("q5_k_s", "Q5_K_S"),
        ("q2_k",   "Q2_K"),   ("q3_k",   "Q3_K"),
        ("q4_0",   "Q4_0"),   ("q4_k",   "Q4_K"),
        ("q5_0",   "Q5_0"),   ("q5_k",   "Q5_K"),
        ("q6_k",   "Q6_K"),
        ("q8_0",   "Q8_0"),   ("q8",     "Q8_0"),
        ("fp16",   "F16"),    ("f16",    "F16"),
        ("f32",    "F32"),
    ] {
        if lower.contains(pat) {
            return label.to_string();
        }
    }

    // Ollama default: untagged "instruct" models ship as Q4_K_M
    if lower.contains("instruct") {
        return "Q4_K_M (default)".to_string();
    }

    "UNKNOWN".to_string()
}

fn extract_parameter_count(name: &str) -> String {
    let lower = name.to_lowercase();
    // Check longer tokens first so "1.5b" is matched before "1b"
    for size in &[
        "110b", "72b", "70b", "34b", "30b", "14b", "13b", "8b", "7b",
        "3b", "1.5b", "1b", "0.5b",
    ] {
        if lower.contains(size) {
            return size.to_uppercase();
        }
    }
    "UNKNOWN".to_string()
}

/// Scan Ollama manifest files at
///   ~/.ollama/models/manifests/registry.ollama.ai/library/MODEL_NAME/TAG
/// and return one `ModelInfo` per tag.
pub fn scan_ollama_models() -> Vec<ModelInfo> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let manifests_path =
        format!("{}/.ollama/models/manifests/registry.ollama.ai/library", home);

    eprintln!("[models] scanning path: {}", manifests_path);
    eprintln!("[models] path exists: {}", std::path::Path::new(&manifests_path).exists());

    let mut models = Vec::new();

    let entries = match std::fs::read_dir(&manifests_path) {
        Ok(e) => e,
        Err(err) => {
            eprintln!("[models] failed to read dir: {}", err);
            return models;
        }
    };

    for model_entry in entries.flatten() {
        let model_name = model_entry.file_name().to_string_lossy().to_string();
        eprintln!("[models] found model dir: {}", model_name);

        let tag_entries = match std::fs::read_dir(model_entry.path()) {
            Ok(e) => e,
            Err(err) => {
                eprintln!("[models] failed to read tags for {}: {}", model_name, err);
                continue;
            }
        };

        for tag_entry in tag_entries.flatten() {
            let tag = tag_entry.file_name().to_string_lossy().to_string();
            eprintln!("[models] found tag: {}:{}", model_name, tag);

            let content = match std::fs::read_to_string(tag_entry.path()) {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("[models] failed to read manifest {}:{}: {}", model_name, tag, err);
                    continue;
                }
            };

            eprintln!("[models] manifest content length: {}", content.len());
            eprintln!("[models] manifest preview: {}", &content[..content.len().min(200)]);

            let manifest: serde_json::Value = match serde_json::from_str(&content) {
                Ok(m) => m,
                Err(err) => {
                    eprintln!("[models] failed to parse manifest: {}", err);
                    continue;
                }
            };

            eprintln!("[models] manifest keys: {:?}",
                manifest.as_object().map(|o| o.keys().collect::<Vec<_>>()));

            let mut total_size: u64 = 0;

            if let Some(layers) = manifest["layers"].as_array() {
                eprintln!("[models] found {} layers", layers.len());
                for layer in layers {
                    if let Some(size) = layer["size"].as_u64() {
                        total_size += size;
                        eprintln!("[models] layer mediaType={:?} size={}",
                            layer["mediaType"].as_str().unwrap_or("?"), size);
                    }
                }
            } else {
                eprintln!("[models] no layers array found");
            }

            // Fallback: count config blob size if layers yielded nothing
            if total_size == 0 {
                if let Some(size) = manifest["config"]["size"].as_u64() {
                    total_size += size;
                    eprintln!("[models] used config.size fallback: {}", size);
                }
            }

            eprintln!("[models] total_size for {}:{} = {}", model_name, tag, total_size);

            if total_size == 0 {
                eprintln!("[models] skipping {}:{} — zero size", model_name, tag);
                continue;
            }

            let estimated_ram_mb = (total_size as f64 * 1.1 / 1024.0 / 1024.0) as u64;
            let estimated_kv_cache_mb = (estimated_ram_mb as f64 * 0.15) as u64;
            let total_required_mb = estimated_ram_mb + estimated_kv_cache_mb;
            let file_size_gb = total_size as f64 / 1024.0 / 1024.0 / 1024.0;

            let quant_source = format!("{} {}", model_name, tag);
            let quantization = extract_quantization_from_name(&quant_source);
            let parameter_count = extract_parameter_count(&quant_source);

            eprintln!("[models] added model: {}:{} size={:.2}GB ram={}MB",
                model_name, tag, file_size_gb, estimated_ram_mb);

            models.push(ModelInfo {
                name: format!("{}:{}", model_name, tag),
                path: tag_entry.path().to_string_lossy().to_string(),
                file_size_bytes: total_size,
                estimated_ram_mb,
                estimated_kv_cache_mb,
                total_required_mb,
                quantization,
                parameter_count,
            });
        }
    }

    eprintln!("[models] total models found: {}", models.len());
    models.sort_by(|a, b| b.file_size_bytes.cmp(&a.file_size_bytes));
    models
}
