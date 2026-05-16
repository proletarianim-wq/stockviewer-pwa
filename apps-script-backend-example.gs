function doGet(e) {
  try {
    const requiredToken = PropertiesService.getScriptProperties().getProperty("VIEWER_TOKEN");
    if (requiredToken) {
      const token = e && e.parameter ? e.parameter.token : "";
      if (token !== requiredToken) return jsonOutput({ ok:false, error:"unauthorized" });
    }
    const data = getDashboardDataFromLiveApi();
    return jsonOutput({ ok:true, ...data });
  } catch (err) {
    return jsonOutput({ ok:false, error: err && err.message ? err.message : String(err) });
  }
}
function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
