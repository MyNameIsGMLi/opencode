using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

/// <summary>
/// ExportRipper Extended v2 (Dependency-Free Edition)
/// Menu: Tools > ExportRipper Extended
///
/// Exports a complete reference map for every prefab:
///   - Each GameObject's name and its components
///   - Each component's localFileID (the &ID used in YAML)
///   - Every serialized object-reference field on each component
///     (both external assets with GUIDs and internal prefab-local fileIDs)
///
/// The resulting JSON is consumed by fix_with_metadata.py to patch ALL
/// Inspector-dragged references in AssetRipper-exported prefabs.
/// </summary>
public class ExportRipperExtended : EditorWindow
{
    [MenuItem("Tools/ExportRipper Extended")]
    public static void ShowWindow() =>
        GetWindow<ExportRipperExtended>("ExportRipper Extended");

    void OnGUI()
    {
        GUILayout.Label("Export Unity Asset Metadata v2", EditorStyles.boldLabel);
        EditorGUILayout.Space();
        if (GUILayout.Button("Export to Project Root"))
            Run(Path.Combine(Application.dataPath, "..", "export2ripper_full.json"));
        if (GUILayout.Button("Export to Desktop"))
            Run(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Desktop),
                             "export2ripper_full.json"));
    }

    // Callable from -executeMethod in batch mode
    public static void BatchExport() =>
        Run(Path.Combine(Application.dataPath, "..", "export2ripper_full.json"));

    // ─────────────────────────────────────────────────────────────────────────
    static void Run(string outputPath)
    {
        Debug.Log("[ExportRipper v2] Starting…");

        var root = new Dictionary<string, object>
        {
            { "version",      "2.0" },
            { "projectName",  Application.productName },
            { "unityVersion", Application.unityVersion },
            { "exportTime",   DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") },
            { "scripts",   ExportScripts()   },
            { "sprites",   ExportAssets<Sprite>("t:Sprite",
                               s => new { localId = LocalFileID(s), textureName = s.texture?.name,
                                          textureGuid = s.texture == null ? "" :
                                              AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(s.texture)) }) },
            { "fonts",     ExportFonts()     },
            { "materials", ExportAssets<Material>("t:Material",
                               m => new { localId = LocalFileID(m), shaderName = m.shader?.name ?? "" }) },
            { "prefabs",   ExportPrefabs()   },
        };

        string json = SerializeJson(root);
        File.WriteAllText(outputPath, json, Encoding.UTF8);
        Debug.Log($"[ExportRipper v2] Done → {outputPath}");
        EditorUtility.DisplayDialog("ExportRipper v2", $"Exported to:\n{outputPath}", "OK");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Generic asset exporter
    // ─────────────────────────────────────────────────────────────────────────
    static List<object> ExportAssets<T>(string filter, Func<T, object> extra) where T : Object
    {
        var list = new List<object>();
        foreach (var guid in AssetDatabase.FindAssets(filter))
        {
            var path  = AssetDatabase.GUIDToAssetPath(guid);
            var asset = AssetDatabase.LoadAssetAtPath<T>(path);
            if (asset == null) continue;
            var entry = new Dictionary<string, object>
            {
                { "guid", guid }, { "name", asset.name }, { "path", path },
            };
            var ext = extra(asset);
            if (ext != null)
                foreach (var p in ext.GetType().GetProperties())
                    entry[p.Name] = p.GetValue(ext, null);
            list.Add(entry);
        }
        Debug.Log($"[ExportRipper v2] {filter}: {list.Count}");
        return list;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scripts
    // ─────────────────────────────────────────────────────────────────────────
    static List<object> ExportScripts()
    {
        var list = new List<object>();
        foreach (var guid in AssetDatabase.FindAssets("t:MonoScript"))
        {
            var path   = AssetDatabase.GUIDToAssetPath(guid);
            var script = AssetDatabase.LoadAssetAtPath<MonoScript>(path);
            if (script?.GetClass() == null) continue;
            var cls = script.GetClass();
            list.Add(new Dictionary<string, object>
            {
                { "guid",      guid },
                { "name",      script.name },
                { "className", cls.Name },
                { "namespace", cls.Namespace ?? "" },
                { "path",      path },
                { "fileID",    ScriptFileID(cls.Namespace, cls.Name) },
            });
        }
        Debug.Log($"[ExportRipper v2] scripts: {list.Count}");
        return list;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fonts (Font + TMP_FontAsset via Reflection)
    // ─────────────────────────────────────────────────────────────────────────
    static List<object> ExportFonts()
    {
        var list = new List<object>();
        foreach (var guid in AssetDatabase.FindAssets("t:Font"))
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            var f    = AssetDatabase.LoadAssetAtPath<Font>(path);
            if (f == null) continue;
            list.Add(new Dictionary<string, object>
            {
                { "guid", guid }, { "name", f.name }, { "path", path },
                { "localId", LocalFileID(f) }, { "type", "Font" },
            });
        }
        foreach (var guid in AssetDatabase.FindAssets("t:TMP_FontAsset"))
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            var f    = AssetDatabase.LoadAssetAtPath<Object>(path);
            if (f == null) continue;
            var entry = new Dictionary<string, object>
            {
                { "guid", guid }, { "name", f.name }, { "path", path },
                { "localId", LocalFileID(f) }, { "type", "TMP_FontAsset" },
            };
            var materialProp = f.GetType().GetProperty("material");
            if (materialProp != null)
            {
                var material = materialProp.GetValue(f, null) as Material;
                if (material != null)
                {
                    entry["materialGuid"] = AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(material));
                    entry["materialName"] = material.name;
                }
            }
            list.Add(entry);
        }
        Debug.Log($"[ExportRipper v2] fonts: {list.Count}");
        return list;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Prefabs — full component reference map
    // ─────────────────────────────────────────────────────────────────────────
    static List<object> ExportPrefabs()
    {
        var list = new List<object>();
        foreach (var guid in AssetDatabase.FindAssets("t:GameObject"))
        {
            var path   = AssetDatabase.GUIDToAssetPath(guid);
            if (!path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)) continue;
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null) continue;
            list.Add(new Dictionary<string, object>
            {
                { "guid",        guid },
                { "name",        prefab.name },
                { "path",        path },
                { "gameObjects", MapPrefab(prefab) },
            });
        }
        Debug.Log($"[ExportRipper v2] prefabs: {list.Count}");
        return list;
    }

    static List<object> MapPrefab(GameObject root)
    {
        var list = new List<object>();
        foreach (var t in root.GetComponentsInChildren<Transform>(true))
        {
            var go      = t.gameObject;
            var goEntry = new Dictionary<string, object>
            {
                { "name",       go.name },
                { "localFileID", LocalFileID(go) },   // fileID of the GameObject itself
                { "components", MapComponents(go) },
            };
            list.Add(goEntry);
        }
        return list;
    }

    static List<object> MapComponents(GameObject go)
    {
        var list = new List<object>();
        foreach (var comp in go.GetComponents<Component>())
        {
            if (comp == null) continue;

            var compEntry = new Dictionary<string, object>
            {
                { "type",        comp.GetType().Name },
                { "localFileID", LocalFileID(comp) },
                { "fields",      MapSerializedFields(comp) },
            };
            list.Add(compEntry);
        }
        return list;
    }

    /// <summary>
    /// Iterates all serialized properties of a component and records every
    /// object-reference field — both external (guid != "") and internal (guid == "").
    /// </summary>
    static List<object> MapSerializedFields(Component comp)
    {
        var fields = new List<object>();
        var so     = new SerializedObject(comp);
        var it     = so.GetIterator();

        bool enterChildren = true;
        while (it.NextVisible(enterChildren))
        {
            enterChildren = it.propertyType != SerializedPropertyType.String;

            if (it.propertyType != SerializedPropertyType.ObjectReference)
                continue;

            // Skip Unity-internal bookkeeping fields
            var name = it.name;
            if (name == "m_CorrespondingSourceObject" ||
                name == "m_PrefabInstance"            ||
                name == "m_PrefabAsset"               ||
                name == "m_GameObject"                ||
                name == "m_Father"                    ||
                name == "m_Icon")
                continue;

            var val = it.objectReferenceValue;

            if (val == null)
            {
                // Field is null/zero — record it so the fixer knows to patch it
                fields.Add(new Dictionary<string, object>
                {
                    { "field",        name },
                    { "path",         it.propertyPath },
                    { "targetFileID", 0 },
                    { "targetGuid",   "" },
                    { "targetName",   "" },
                    { "targetType",   "" },
                });
            }
            else
            {
                string assetPath = AssetDatabase.GetAssetPath(val);
                string extGuid   = string.IsNullOrEmpty(assetPath) ? "" :
                                       AssetDatabase.AssetPathToGUID(assetPath);

                fields.Add(new Dictionary<string, object>
                {
                    { "field",        name },
                    { "path",         it.propertyPath },
                    { "targetFileID", LocalFileID(val) },
                    { "targetGuid",   extGuid },           // "" if internal (same prefab)
                    { "targetName",   val.name },
                    { "targetType",   val.GetType().Name },
                });
            }
        }
        return fields;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    static long LocalFileID(Object obj)
    {
        if (obj == null) return 0;
        try   { return (long)Unsupported.GetLocalIdentifierInFileForPersistentObject(obj); }
        catch { return obj is Sprite ? 21300000 : obj is ScriptableObject ? 11400000 : 0; }
    }

    static long ScriptFileID(string ns, string className)
    {
        string data = "s\0\0\0" + (ns ?? "") + className;
        byte[] hash = MD5.Create().ComputeHash(Encoding.UTF8.GetBytes(data));
        long r = 0;
        for (int i = 3; i >= 0; i--) { r <<= 8; r |= hash[i]; }
        return r;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dependency-Free JSON Serializer
    // ─────────────────────────────────────────────────────────────────────────
    static string SerializeJson(object obj)
    {
        if (obj == null) return "null";
        if (obj is string) return "\"" + EscapeJson((string)obj) + "\"";
        if (obj is bool) return ((bool)obj) ? "true" : "false";
        if (obj is int || obj is long || obj is float || obj is double) return obj.ToString();
        if (obj is IDictionary<string, object>)
        {
            var dict = (IDictionary<string, object>)obj;
            var sb = new StringBuilder();
            sb.Append("{");
            bool first = true;
            foreach (var kvp in dict)
            {
                if (!first) sb.Append(",");
                first = false;
                sb.Append("\"" + EscapeJson(kvp.Key) + "\":");
                sb.Append(SerializeJson(kvp.Value));
            }
            sb.Append("}");
            return sb.ToString();
        }
        if (obj is IEnumerable)
        {
            var list = (IEnumerable)obj;
            var sb = new StringBuilder();
            sb.Append("[");
            bool first = true;
            foreach (var item in list)
            {
                if (!first) sb.Append(",");
                first = false;
                sb.Append(SerializeJson(item));
            }
            sb.Append("]");
            return sb.ToString();
        }
        
        // Handle anonymous types or custom classes via reflection
        {
            var sb = new StringBuilder();
            sb.Append("{");
            bool first = true;
            foreach (var prop in obj.GetType().GetProperties())
            {
                if (!first) sb.Append(",");
                first = false;
                sb.Append("\"" + EscapeJson(prop.Name) + "\":");
                sb.Append(SerializeJson(prop.GetValue(obj, null)));
            }
            sb.Append("}");
            return sb.ToString();
        }
    }

    static string EscapeJson(string str)
    {
        if (string.IsNullOrEmpty(str)) return "";
        return str.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
    }
}
