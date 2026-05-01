import json
from mitmproxy import ctx


def _header_map(headers):
    return {k: v for k, v in headers.items(multi=True)}


def response(flow):
    flows_path = ctx.options.pi_flows_path
    payload = {
        "url": flow.request.pretty_url,
        "method": flow.request.method,
        "requestheaders": _header_map(flow.request.headers),
        "responseheaders": _header_map(flow.response.headers),
        "status": flow.response.status_code,
        "requestBody": flow.request.get_text(strict=False),
        "responseBody": flow.response.get_text(strict=False),
    }
    with open(flows_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload) + "\\n")
