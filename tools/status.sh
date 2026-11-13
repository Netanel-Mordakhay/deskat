#!/bin/zsh
# Background-removal progress for a cat, from a process_all.sh log: frames done / total.
# usage: tools/status.sh <cat> <log>
cd "${0:A:h}/.."
cat=$1; log=$2
txt=$(tr '\r' '\n' < $log 2>/dev/null)
finished=(${(f)"$(echo $txt | grep -E '^[a-z_]+: [0-9]+ frames ->' | cut -d: -f1)"})
cur=$(echo $txt | grep -E "^[a-z_]+: [a-z]+ [0-9]+/" | tail -1)
curclip=${cur%%:*}; curn=$(echo $cur | sed -E 's/.* ([0-9]+)\/.*/\1/')
total=0; done=0
for f in $cat/raw/*.mp4; do
  c=${f:t:r}; [[ $c == *_full ]] && continue
  n=$(ffprobe -v error -count_packets -select_streams v -show_entries stream=nb_read_packets -of csv=p=0 $f)
  total=$((total+n))
  if (( ${finished[(Ie)$c]} )); then done=$((done+n)); elif [[ $c == $curclip ]]; then done=$((done+curn)); fi
done
echo "$cat: $done/$total frames = $((100*done/total))%  (${#finished} clips done; now: ${cur:-waiting})"
