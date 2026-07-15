// hostscript.jsx
// ExtendScript side of Moire Remover (Auto).
// Everything here runs inside Photoshop's own scripting engine, not the browser.

#target photoshop

// ExtendScript's built-in JSON support is inconsistent across Photoshop
// versions/builds, so we serialize by hand instead of relying on
// JSON.stringify. Every object we return here is flat with only
// string/number/boolean/null values, so this simple serializer is enough.
function _quote(s) {
    s = String(s);
    s = s.split("\\").join("\\\\");
    s = s.split('"').join('\\"');
    s = s.split("\n").join("\\n");
    s = s.split("\r").join("\\r");
    s = s.split("\t").join("\\t");
    return '"' + s + '"';
}

function _toJSON(obj) {
    var parts = [];
    for (var key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        var val = obj[key];
        var jsonVal;
        if (val === null || val === undefined) {
            jsonVal = "null";
        } else if (typeof val === "number" || typeof val === "boolean") {
            jsonVal = String(val);
        } else {
            jsonVal = _quote(val);
        }
        parts.push(_quote(key) + ":" + jsonVal);
    }
    return "{" + parts.join(",") + "}";
}

function _ok(obj) {
    return _toJSON(obj);
}

function _err(e) {
    return _toJSON({ ok: false, error: (e && e.message) ? e.message : String(e) });
}

// Returns the OS temp folder path (used to stage the PNG round-trip).
function getTempDir() {
    try {
        return _ok({ ok: true, path: Folder.temp.fsName });
    } catch (e) {
        return _err(e);
    }
}

// Confirms a document is open and that the active layer is the topmost
// top-level layer in the stack (this is the safety check the user asked for:
// only ever touch the layer that is both "selected" and "on top").
function checkActiveLayerIsTop() {
    try {
        if (!app.documents.length) {
            return _ok({ ok: true, isTopLayer: false, reason: "no_document" });
        }
        var doc = app.activeDocument;
        if (!doc.layers.length) {
            return _ok({ ok: true, isTopLayer: false, reason: "no_layers" });
        }
        var active = doc.activeLayer;
        var top = doc.layers[0];
        var isTop = (active.itemIndex === top.itemIndex);
        return _ok({
            ok: true,
            isTopLayer: isTop,
            reason: isTop ? "" : "not_top",
            layerName: active.name,
            docName: doc.name,
            width: doc.width.as("px"),
            height: doc.height.as("px"),
            resolution: doc.resolution
        });
    } catch (e) {
        return _err(e);
    }
}

// Duplicates the whole document, strips every layer except the (already
// verified) topmost one, flattens it, and saves it out as a PNG at outPath.
// Working on a duplicate means the user's original document is never touched
// by this step.
function exportActiveLayerToPNG(outPath) {
    var srcDoc = app.activeDocument;
    var dupDoc = null;
    try {
        dupDoc = srcDoc.duplicate(srcDoc.name + "_moire_tmp", false);

        // Keep only the top layer: repeatedly remove the bottom-most one.
        while (dupDoc.layers.length > 1) {
            dupDoc.layers[dupDoc.layers.length - 1].remove();
        }

        // Flatten renders any layer styles/opacity into plain pixels.
        dupDoc.flatten();

        var file = new File(outPath);
        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        pngOpts.interlaced = false;
        dupDoc.saveAs(file, pngOpts, true, Extension.LOWERCASE);

        dupDoc.close(SaveOptions.DONOTSAVECHANGES);
        dupDoc = null;

        return _ok({ ok: true, path: outPath });
    } catch (e) {
        if (dupDoc) {
            try { dupDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        }
        return _err(e);
    }
}

// Opens the cleaned PNG and copies it into the original document as a new
// top layer, aligned automatically because both documents share the same
// pixel dimensions. The original layer underneath is left untouched, so the
// whole operation is non-destructive (the user can toggle/delete the new
// layer at any time).
function importResultAsLayer(pngPath, layerName) {
    var srcDoc = app.activeDocument;
    var resDoc = null;
    try {
        var file = new File(pngPath);
        if (!file.exists) {
            throw new Error("processed_file_missing");
        }
        resDoc = app.open(file);
        resDoc.layers[0].duplicate(srcDoc, ElementPlacement.PLACEATBEGINNING);
        resDoc.close(SaveOptions.DONOTSAVECHANGES);
        resDoc = null;

        srcDoc.activeLayer.name = layerName;
        return _ok({ ok: true });
    } catch (e) {
        if (resDoc) {
            try { resDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        }
        return _err(e);
    }
}

// Best-effort cleanup of the temp files once we're done with them.
function deleteTempFile(path) {
    try {
        var f = new File(path);
        if (f.exists) f.remove();
        return _ok({ ok: true });
    } catch (e) {
        return _err(e);
    }
}
