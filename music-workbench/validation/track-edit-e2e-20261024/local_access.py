"""Validate the real HTTP authority before any loopback-only app operation."""
def local_request_allowed(headers, port, target):
    hosts = headers.get_all('Host', [])
    origins = headers.get_all('Origin', [])
    allowed = {f'127.0.0.1:{port}', f'localhost:{port}'}
    if port == 80:
        allowed.update(('127.0.0.1', 'localhost'))
    if len(hosts) != 1 or hosts[0].lower() not in allowed:
        return False
    if len(origins) > 1 or origins and origins[0] != 'http://' + hosts[0].lower():
        return False
    if headers.get('Sec-Fetch-Site', '').lower() == 'cross-site':
        return False
    # Absolute-form request targets must not bypass the checked Host header.
    return target.startswith('/') and not target.startswith('//')
