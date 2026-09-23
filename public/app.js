const $ = (s) => document.querySelector(s);

const setup = $("#setup");
const viewer = $("#viewer");
const form = $("#form");
const urlInput = $("#url");
const errorEl = $("#error");
const chat = $("#chat");
const channelName = $("#channelName");
const channelImg = $("#channelImg");
const status = $("#status");
const settingsPanel = $("#settingsPanel");

let eventSource = null;
let fontSize = Number(localStorage.getItem("chatFontSize") || 16);
let autoScroll = localStorage.getItem("autoScroll") !== "false";
let showName = localStorage.getItem("showName") !== "false";
let maxMessages = Number(localStorage.getItem("maxMessages") || 200);

document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
$("#autoScroll").checked = autoScroll;
$("#showName").checked = showName;
$("#maxMessages").value = String(maxMessages);

function showError(msg) {
  errorEl.textContent = msg || "";
}

function scrollIfNeeded() {
  if (!autoScroll) return;
  chat.scrollTop = chat.scrollHeight;
}

function addMessage(data) {
  const row = document.createElement("div");
  row.className = "message";

  if (showName) {
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = data.nickname || "알 수 없음";
    row.appendChild(name);
  }

  const content = document.createElement("span");
  content.className = "content";

  // 텍스트는 textContent로 넣어 XSS를 막습니다.
  content.textContent = data.content || "";
  row.appendChild(content);

  chat.appendChild(row);

  while (chat.children.length > maxMessages) {
    chat.removeChild(chat.firstChild);
  }
  scrollIfNeeded();
}

function connect(channelUrl) {
  if (eventSource) eventSource.close();
  chat.innerHTML = "";
  status.textContent = "연결 중…";

  const endpoint = `/api/stream?url=${encodeURIComponent(channelUrl)}`;
  eventSource = new EventSource(endpoint);

  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.type === "channel") {
        channelName.textContent = data.channelName || "채널";
        channelImg.src = data.channelImageUrl || "";
        status.textContent = "실시간 채팅";
      } else if (data.type === "chat") {
        addMessage(data);
        status.textContent = "● 연결됨";
      } else if (data.type === "status") {
        status.textContent = data.message;
      } else if (data.type === "error") {
        status.textContent = "연결 오류";
      }
    } catch {}
  };

  eventSource.onerror = () => {
    status.textContent = "재연결 중…";
  };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");

  const url = urlInput.value.trim();
  if (!url) return showError("방송 URL을 입력해주세요.");

  try {
    const r = await fetch(`/api/channel?url=${encodeURIComponent(url)}`);
    const data = await r.json();

    if (!r.ok) throw new Error(data.error || "채널을 확인할 수 없습니다.");

    setup.classList.add("hidden");
    viewer.classList.remove("hidden");
    connect(url);

    // 새로고침해도 같은 방송을 바로 열 수 있게 저장
    localStorage.setItem("lastChannelUrl", url);
    history.replaceState(null, "", `?channel=${encodeURIComponent(data.channelId)}`);
  } catch (err) {
    showError(err.message);
  }
});

$("#fontMinus").onclick = () => {
  fontSize = Math.max(12, fontSize - 1);
  document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
  localStorage.setItem("chatFontSize", fontSize);
};

$("#fontPlus").onclick = () => {
  fontSize = Math.min(30, fontSize + 1);
  document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
  localStorage.setItem("chatFontSize", fontSize);
};

$("#settings").onclick = () => settingsPanel.classList.toggle("hidden");

$("#autoScroll").onchange = (e) => {
  autoScroll = e.target.checked;
  localStorage.setItem("autoScroll", autoScroll);
};

$("#showName").onchange = (e) => {
  showName = e.target.checked;
  localStorage.setItem("showName", showName);
};

$("#maxMessages").onchange = (e) => {
  maxMessages = Number(e.target.value);
  localStorage.setItem("maxMessages", maxMessages);
};

$("#back").onclick = () => {
  if (eventSource) eventSource.close();
  viewer.classList.add("hidden");
  setup.classList.remove("hidden");
  settingsPanel.classList.add("hidden");
};

window.addEventListener("load", () => {
  const saved = localStorage.getItem("lastChannelUrl");
  if (saved) {
    urlInput.value = saved;
  }
});