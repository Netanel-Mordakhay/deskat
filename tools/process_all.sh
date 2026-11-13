#!/bin/zsh
# Process every raw clip of a cat that has no final webm yet (or all with --force).
cd "${0:A:h}/.."
cat=$1; shift
for f in $cat/raw/*.mp4; do
  c=${f:t:r}
  [[ $c == *_full ]] && continue
  [[ "$1" != "--force" && -f $cat/final/$c.webm ]] && continue
  tools/.venv/bin/python tools/process_clip.py $cat $c || echo "FAILED $c"
done
