export function createRefreshLoop({refresh,onError=()=>{},isVisible=()=>true,interval=60000,setTimer=setTimeout,clearTimer=clearTimeout}){
 let running=null,timer=null,queued=false,stopped=true;
 function pause(){if(timer!==null){clearTimer(timer);timer=null;}}
 function schedule(){pause();if(!stopped&&isVisible())timer=setTimer(wake,interval);}
 function wake(){
  if(stopped||!isVisible())return Promise.resolve();
  if(running){queued=true;return running;}
  pause();
  running=Promise.resolve().then(refresh).catch(onError).finally(()=>{
   running=null;
   if(stopped)return;
   if(queued){queued=false;void wake();}else schedule();
  });
  return running;
 }
 return {start(){stopped=false;return wake();},wake,pause,stop(){stopped=true;queued=false;pause();}};
}
