// index.js — panel glue code. Runs in the CEP panel's mixed context, so both
// browser APIs (canvas, Image) and Node's `require` are available.

(function () {
  "use strict";

  var runBtn = document.getElementById("runBtn");
  var progressWrap = document.getElementById("progressWrap");
  var progressBar = document.getElementById("progressBar");
  var progressLabel = document.getElementById("progressLabel");
  var errorBox = document.getElementById("errorBox");
  var successBox = document.getElementById("successBox");
  var advancedToggle = document.getElementById("advancedToggle");
  var advancedPanel = document.getElementById("advancedPanel");
  var sensSlider = document.getElementById("sensSlider");
  var sensVal = document.getElementById("sensVal");
  var notchSlider = document.getElementById("notchSlider");
  var notchVal = document.getElementById("notchVal");
  var ringEnabledBox = document.getElementById("ringEnabled");
  var ringSlider = document.getElementById("ringSlider");
  var ringVal = document.getElementById("ringVal");

  advancedToggle.addEventListener("click", function () {
    advancedPanel.classList.toggle("hidden");
  });
  sensSlider.addEventListener("input", function () {
    sensVal.textContent = parseFloat(sensSlider.value).toFixed(1);
  });
  notchSlider.addEventListener("input", function () {
    notchVal.textContent = notchSlider.value;
  });
  ringSlider.addEventListener("input", function () {
    ringVal.textContent = parseFloat(ringSlider.value).toFixed(1);
  });

  function evalScriptAsync(script) {
    return new Promise(function (resolve, reject) {
      if (!window.__adobe_cep__) {
        reject(new Error("Панель запущена вне Photoshop (нет __adobe_cep__)."));
        return;
      }
      window.__adobe_cep__.evalScript(script, function (result) {
        resolve(result);
      });
    });
  }

  function callHost(fnName /*, ...args as already-JSON-stringified strings */) {
    var args = Array.prototype.slice.call(arguments, 1);
    var script = fnName + "(" + args.join(",") + ")";
    return evalScriptAsync(script).then(function (raw) {
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new Error("Не удалось разобрать ответ от Photoshop: " + raw);
      }
      if (!parsed.ok) {
        throw new Error(parsed.error || "Неизвестная ошибка скрипта Photoshop.");
      }
      return parsed;
    });
  }

  function setProgress(pct, label) {
    progressWrap.classList.remove("hidden");
    progressBar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (label) progressLabel.textContent = label;
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
  }

  function showSuccess(msg) {
    successBox.textContent = msg;
    successBox.classList.remove("hidden");
  }

  function resetMessages() {
    errorBox.classList.add("hidden");
    successBox.classList.add("hidden");
  }

  function loadImageFromFile(fs, path) {
    return new Promise(function (resolve, reject) {
      var bytes;
      try {
        bytes = fs.readFileSync(path);
      } catch (e) {
        reject(new Error("Не удалось прочитать временный файл: " + e.message));
        return;
      }
      var base64 = bytes.toString("base64");
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("Не удалось декодировать временный PNG.")); };
      img.src = "data:image/png;base64," + base64;
    });
  }

  function friendlyError(err) {
    var msg = err && err.message ? err.message : String(err);
    if (msg === "no_document") return "Нет открытого документа.";
    if (msg === "no_layers") return "В документе нет слоёв.";
    if (msg === "not_top") return "Выберите самый верхний слой документа — фильтр работает только с ним.";
    if (msg === "image_too_large") {
      return "Изображение слишком большое для обработки в панели. Уменьшите размер (Image ▸ Image Size), запустите фильтр, затем увеличьте обратно.";
    }
    if (msg === "processed_file_missing") return "Обработанный файл не найден — попробуйте ещё раз.";
    return msg;
  }

  async function run() {
    resetMessages();
    runBtn.disabled = true;
    setProgress(0, "Проверка слоя...");

    var fs;
    try {
      fs = require("fs");
    } catch (e) {
      showError("Node.js недоступен в панели. Проверьте, что расширение установлено с поддержкой --mixed-context (см. README).");
      runBtn.disabled = false;
      return;
    }

    var srcPath = null;
    var dstPath = null;

    try {
      var check = await callHost("checkActiveLayerIsTop");
      if (!check.isTopLayer) {
        throw new Error(check.reason || "not_top");
      }

      setProgress(5, "Экспорт слоя из Photoshop...");
      var tempInfo = await callHost("getTempDir");
      var stamp = Date.now();
      var sep = tempInfo.path.indexOf("\\") >= 0 ? "\\" : "/";
      srcPath = tempInfo.path + sep + "moire_src_" + stamp + ".png";
      dstPath = tempInfo.path + sep + "moire_out_" + stamp + ".png";

      await callHost("exportActiveLayerToPNG", JSON.stringify(srcPath));

      setProgress(12, "Загрузка изображения в панель...");
      var img = await loadImageFromFile(fs, srcPath);

      var canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      var sensitivity = parseFloat(sensSlider.value);
      var notchRadius = parseInt(notchSlider.value, 10);
      var ringEnabled = !!ringEnabledBox.checked;
      var ringThresholdDb = parseFloat(ringSlider.value);

      setProgress(15, "Анализ спектра и удаление муара...");
      var result = await window.MoireRemover.removeMoire(
        imageData,
        {
          sensitivity: sensitivity,
          notchRadius: notchRadius,
          maxPeaks: 4000,
          ringEnabled: ringEnabled,
          ringThresholdDb: ringThresholdDb
        },
        function (pct, label) { setProgress(pct, label); }
      );

      var outImageData = new ImageData(result.data, result.width, result.height);
      ctx.putImageData(outImageData, 0, 0);

      setProgress(95, "Сохранение результата...");
      var dataUrl = canvas.toDataURL("image/png");
      var base64Payload = dataUrl.substring(dataUrl.indexOf(",") + 1);
      var buffer = Buffer.from(base64Payload, "base64");
      fs.writeFileSync(dstPath, buffer);

      setProgress(98, "Добавление нового слоя...");
      await callHost("importResultAsLayer", JSON.stringify(dstPath), JSON.stringify("Moire Removed (Auto)"));

      setProgress(100, "Готово");
      var msg = "Готово: точечных частот подавлено — " + result.peaksFound + ".";
      msg += result.ringBandsFound ? " Также найдена и смягчена фактура бумаги." : (ringEnabled ? " Равномерной фактуры бумаги не обнаружено." : "");
      msg += " Новый слой добавлен сверху, исходный слой не тронут.";
      showSuccess(msg);
    } catch (err) {
      showError(friendlyError(err));
    } finally {
      try { if (srcPath) await callHost("deleteTempFile", JSON.stringify(srcPath)); } catch (e) {}
      try { if (dstPath) await callHost("deleteTempFile", JSON.stringify(dstPath)); } catch (e) {}
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener("click", run);
})();
