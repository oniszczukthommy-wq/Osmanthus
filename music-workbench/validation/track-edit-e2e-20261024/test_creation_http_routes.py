"""Exercise actual handler branches without importing or starting the app."""
import ast,re,types,unittest
from pathlib import Path
from urllib.parse import urlparse,unquote

class CreationHttpRoutesTests(unittest.TestCase):
    def handler(self,exception=None):
        tree=ast.parse(Path(__file__).with_name('server.py').read_text())
        owner=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Handler')
        method=next(n for n in owner.body if isinstance(n,ast.FunctionDef) and n.name=='do_GET')
        def read(identifier):
            if exception:raise exception
            return {'id':identifier}
        flow=types.SimpleNamespace(read=read,public=lambda state:state)
        scope={'re':re,'urlparse':urlparse,'unquote':unquote,'CREATE_FLOW':flow}
        exec(compile(ast.Module(body=[method],type_ignores=[]),'server_creation_route','exec'),scope)
        instance=types.SimpleNamespace(path='/api/creation/jobs/11111111-1111-4111-8111-111111111111',json=lambda status,body:(status,body))
        return scope['do_GET'](instance)

    def test_found_request_returns_200(self):self.assertEqual(self.handler()[0],200)
    def test_missing_request_returns_404(self):self.assertEqual(self.handler(ValueError('missing')),(404,{'error':'missing'}))
    def test_corrupt_request_returns_409_and_cannot_be_mistaken_for_absence(self):self.assertEqual(self.handler(RuntimeError('corrupt')),(409,{'error':'corrupt'}))

if __name__=='__main__':unittest.main()
