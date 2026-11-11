"""Package tracked source and the prebuilt browser app for self-hosted use."""
import argparse
from pathlib import Path
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile

root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('output',type=Path)
args=parser.parse_args()
output=args.output.resolve()
output.parent.mkdir(parents=True,exist_ok=True)
subprocess.run(['npm','run','build'],cwd=root,check=True)
tracked=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().rstrip('\0').split('\0')
with ZipFile(output,'w',ZIP_DEFLATED,compresslevel=6) as archive:
    for name in tracked:
        archive.write(root/name,'assembly-workshop/'+name)
    for path in sorted((root/'dist').rglob('*')):
        if path.is_file():
            archive.write(path,'assembly-workshop/'+path.relative_to(root).as_posix())
print(output)
