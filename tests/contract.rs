use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn text(path: &str) -> String {
    fs::read_to_string(root().join(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn json(path: &str) -> Value {
    serde_json::from_str(&text(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
}

#[test]
fn manifest_registers_one_admin_only_full_bleed_screen() {
    let manifest = json("ui/manifest.json");
    assert_eq!(manifest["schema"], "pom-plugin-ui/v1");
    assert_eq!(manifest["plugin_code"], "deepseek_harness");

    let menu = manifest["menu"].as_array().expect("menu array");
    assert_eq!(menu.len(), 1);
    assert_eq!(menu[0]["to"], "/harness");
    assert_eq!(menu[0]["label"]["en"], "Deepseek Harness");
    assert_eq!(menu[0]["roles"], serde_json::json!(["admin"]));
    // One of the names the POM resolves; anything else falls back to a generic icon.
    assert_eq!(menu[0]["icon"], "terminal");

    let routes = manifest["routes"].as_array().expect("routes array");
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0]["path"], "/harness");
    assert_eq!(routes[0]["screen"], "harness");
    assert_eq!(routes[0]["full_bleed"], true);
    assert_eq!(routes[0]["roles"], serde_json::json!(["admin"]));

    let screen = &manifest["screens"]["harness"];
    assert_eq!(screen["module"], "ui/screens.js");
    assert_eq!(screen["export"], "harness");
    assert_eq!(screen["styles"], serde_json::json!(["ui/plugin.css"]));
    assert!(text("ui/src/screens/index.tsx").contains("Harness as harness"));
}

#[test]
fn assets_include_the_dynamic_runtime_status() {
    let manifest = json("ui/manifest.json");
    let assets: BTreeSet<_> = manifest["assets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|asset| asset.as_str().unwrap())
        .collect();
    assert_eq!(
        assets,
        BTreeSet::from([
            "ui/screens.js",
            "ui/plugin.css",
            "ui/runtime.json",
            "i18n/en.json",
            "i18n/pt-BR.json",
        ])
    );
    assert!(text("ui/src/screens/Harness.tsx").contains("\"ui/runtime.json\""));
    assert!(text("src/lib.rs").contains("const RUNTIME_ASSET: &str = \"ui/runtime.json\";"));
}

#[test]
fn catalogs_match_each_other_and_the_keys_the_screen_uses() {
    let en = json("i18n/en.json");
    let pt = json("i18n/pt-BR.json");
    let en_keys: BTreeSet<_> = en.as_object().unwrap().keys().cloned().collect();
    let pt_keys: BTreeSet<_> = pt.as_object().unwrap().keys().cloned().collect();
    assert_eq!(en_keys, pt_keys);

    let source = text("ui/src/screens/Harness.tsx");
    let mut used = BTreeSet::new();
    for rest in source.split('"').skip(1).step_by(2) {
        if en_keys.contains(rest) {
            used.insert(rest.to_owned());
        }
    }
    assert_eq!(
        used, en_keys,
        "every catalog key is used and none is missing"
    );
}

#[test]
fn screen_styles_stay_inside_the_plugin_namespace() {
    let css = text("ui/src/plugin.css");
    assert!(!css.contains(":root") && !css.contains("body"));
    for line in css
        .lines()
        .filter(|line| line.ends_with('{') && !line.starts_with(' '))
    {
        assert!(
            line.starts_with(".pb-") || line.starts_with("@keyframes pb-"),
            "unscoped rule: {line}"
        );
    }
}

#[test]
fn launcher_is_shipped_by_the_runtime_script_and_started_by_the_library() {
    assert!(text("scripts/fetch-runtime.sh").contains("runtime/launcher.mjs"));
    assert!(text("src/supervisor.rs").contains("launcher.mjs"));
    let launcher = text("runtime/launcher.mjs");
    assert!(launcher.contains("\"--profile\", \"web\""));
    assert!(launcher.contains("DSH_POM_LLM_BASE_URL"));
}
