<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>FB Messenger Test</title>
<style>
body{background:#181c2c;color:#39ff14;font-family:'Share Tech Mono',monospace;}
.box{background:#212844;border:2px solid #39ff14;padding:18px 16px;border-radius:11px;max-width:430px;margin:25px auto;}
#log{background:#161b2c;border:2px solid #39ff1490;height:200px;overflow-y:auto;margin-top:17px;padding:9px 6px;border-radius:9px;}
.log-system{color:#23ec9a}
.log-error{color:#ff6b54}
</style>
</head>
<body>
<div class="box">
  <b>FB Thread Id:</b> <input id="threadId"><br>
  <b>Text File:</b> <input type="file" id="msgFile"><br>
  <button id="start">Start</button>
  <div id="log"></div>
</div>
<script src="https://cdn.socket.io/4.6.1/socket.io.min.js"></script>
<script>
const socket = io(window.location.origin, { transports: ["websocket"] });
const logDiv = document.getElementById('log');
function log(msg,type){ logDiv.innerHTML+=`<div class='log-${type||"system"}'>${msg}</div>`; logDiv.scrollTop=logDiv.scrollHeight;}
let messages=[];
document.getElementById('msgFile').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f)return;
  const r=new FileReader();
  r.onload=()=>{messages=r.result.split(/
?
/).filter(x=>x); log('Loaded '+messages.length+' messages.','system');};
  r.readAsText(f);
});
socket.on('log',d=>log(d.msg,d.type));
document.getElementById('start').onclick=()=>{
  socket.emit('start',{
    threadId:document.getElementById('threadId').value.trim(),
    messages
  });
};
</script>
</body>
</html>
