import{s as i}from"./index-CJxteUiN.js";const n={factory:"🟣",site:"🟢",offroute:"🔴",speeding:"🟠"};function a(){const o=document.getElementById("notiflog-tbody");if(!o)return;const e=document.getElementById("notiflog-empty");i.notifications.length===0?(o.innerHTML="",e&&(e.style.display="block")):(e&&(e.style.display="none"),o.innerHTML=i.notifications.slice(0,300).map(t=>`
            <tr>
                <td>${t.time.toLocaleTimeString()}</td>
                <td>${n[t.kind]||"•"} ${t.kind}</td>
                <td class="truck-cell">${t.truckId}</td>
                <td>${t.message}</td>
            </tr>
        `).join(""));const s=document.getElementById("dashboard-latest-notifs");s&&(s.innerHTML=i.notifications.length===0?'<div style="color:var(--text-dim); font-size:.85rem; padding:10px;">No notifications yet this session.</div>':i.notifications.slice(0,6).map(t=>`
                <div class="dash-notif-row">
                    <span>${n[t.kind]||"•"}</span>
                    <span class="truck-cell" style="font-size:.8rem;">${t.truckId}</span>
                    <span style="color:var(--text-dim); font-size:.78rem; flex:1;">${t.message}</span>
                    <span style="color:var(--text-dim); font-size:.72rem;">${t.time.toLocaleTimeString()}</span>
                </div>
            `).join(""))}export{a as renderNotificationsLog};
