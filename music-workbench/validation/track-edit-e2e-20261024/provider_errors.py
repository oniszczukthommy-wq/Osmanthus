"""User-facing provider errors without exposing provider responses or credentials."""


def http_failure(status, service, *, submission=False):
    """Describe only facts supported by the HTTP status; never echo response text."""
    label = '写词服务' if service == 'lyrics' else '音乐服务'
    suffix = '原输入已保留。' if service == 'lyrics' else '请先查看原任务状态，避免重复提交。'
    if status == 402:
        return f'{label}提示付款或额度问题，请检查服务账户余额和使用额度。{suffix}'
    if status in (401, 403):
        return f'{label}未通过身份验证或没有访问权限，请检查服务配置和账户权限。{suffix}'
    if status == 429:
        return f'{label}暂时限流或达到调用额度，请稍后检查服务额度。{suffix}'
    if status == 409 and submission:
        return f'{label}返回请求冲突，提交结果尚未确认。{suffix}'
    if status in (400, 404, 405, 409, 413, 415, 422):
        return f'{label}未接受请求，请检查输入和服务配置。{suffix}'
    if submission:
        return f'{label}响应异常，提交结果尚未确认。{suffix}'
    return f'{label}暂时不可用，请稍后查看状态。{suffix}'


def lyrics_curl_failure(returncode, status):
    if status:
        return http_failure(status, 'lyrics')
    if returncode == 28:
        return '写词服务连接超时，本次写词结果未知；原输入已保留，请先检查任务状态。'
    return '写词服务连接失败，本次写词结果未知；原输入已保留，请先检查任务状态。'


def split_curl_response(raw):
    """Split the final curl status marker without trusting arbitrary body content."""
    marker = b'\n__OSMANTHUS_HTTP_STATUS__:'
    body, found, status = raw.rpartition(marker)
    if found and len(status) == 3 and status.isdigit():
        return body, int(status)
    return raw, None
