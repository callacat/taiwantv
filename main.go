package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/proxy"
)

var (
	port        = env("PORT", "3000")
	dataDir     = env("DATA_DIR", "./data")
	socks5Proxy = env("SOCKS5_PROXY", "")
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ─── Simplified Chinese ──────────────────────────
var simpMap = map[rune]rune{
	'綜': '综', '藝': '艺', '臺': '台', '劇': '剧', '畫': '画', '電': '电',
	'影': '影', '視': '视', '頻': '频', '道': '道', '聞': '闻', '體': '体',
	'動': '动', '兒': '儿', '童': '童', '戲': '戏', '樂': '乐', '際': '际',
	'關': '关', '鍵': '键', '東': '东', '龍': '龙', '華': '华', '萬': '万',
	'風': '风', '雲': '云', '會': '会', '時': '时', '報': '报', '導': '导',
	'財': '财', '經': '经', '運': '运', '愛': '爱', '爾': '尔', '達': '达',
	'賽': '赛', '訊': '讯', '語': '语', '選': '选', '優': '优', '魚': '鱼',
	'豬': '猪', '哥': '哥', '亮': '亮', '歌': '歌', '廳': '厅', '秀': '秀',
	'金': '金', '光': '光', '布': '布', '袋': '袋', '貓': '猫', '夢': '梦',
	'綠': '绿', '綺': '绮', '麗': '丽', '絢': '绚', '籃': '篮', '賞': '赏',
	'輕': '轻', '鬆': '松', '養': '养', '遊': '游', '靈': '灵', '驚': '惊',
	'點': '点',
}

func toSimplified(s string) string {
	return strings.Map(func(r rune) rune {
		if v, ok := simpMap[r]; ok {
			return v
		}
		return r
	}, s)
}

// ─── Channel ────────────────────────────────────
type Channel struct {
	Name  string `json:"name"`
	URL   string `json:"-"`
	Group string `json:"group"`
}

var (
	channels   []Channel
	channelsMu sync.RWMutex
)

// ─── Sources ────────────────────────────────────
type Source struct{ URL, Format string }

var sources = []Source{
	{URL: "https://t.freetv.fun/m3u/taiwan.txt", Format: "txt"},
	{URL: "https://iptv-org.github.io/iptv/countries/tw.m3u", Format: "m3u"},
}

// ─── Parsers ────────────────────────────────────
func parseTXT(body string) []Channel {
	var out []Channel
	group := "Taiwan"
	reBracket := regexp.MustCompile(`\[.*?\]`)

	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || t[0] == '#' {
			continue
		}
		if strings.Contains(t, "#genre#") {
			group = toSimplified(strings.TrimSpace(strings.Split(t, ",")[0]))
			continue
		}
		if !strings.Contains(t, ",") {
			continue
		}
		i := strings.Index(t, ",")
		rawName := strings.TrimSpace(t[:i])
		u := strings.TrimSpace(t[i+1:])
		if rawName == "" || (!strings.HasPrefix(u, "http") && !strings.HasPrefix(u, "rtmp")) {
			continue
		}
		name := strings.TrimSpace(reBracket.ReplaceAllString(rawName, ""))
		name = toSimplified(name)
		out = append(out, Channel{Name: name, URL: u, Group: group})
	}
	return out
}

func parseM3U(body string) []Channel {
	var out []Channel
	var name, group string
	reBracket := regexp.MustCompile(`\[.*?\]`)

	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "#EXTINF:") {
			if m := regexp.MustCompile(`,([^,]+)$`).FindStringSubmatch(t); len(m) > 1 {
				name = strings.TrimSpace(reBracket.ReplaceAllString(m[1], ""))
				name = toSimplified(name)
			}
			if g := regexp.MustCompile(`group-title="([^"]+)"`).FindStringSubmatch(t); len(g) > 1 {
				group = toSimplified(g[1])
			}
		} else if (strings.HasPrefix(t, "http") || strings.HasPrefix(t, "rtmp")) && name != "" {
			out = append(out, Channel{Name: name, URL: t, Group: group})
			name, group = "", ""
		}
	}
	return out
}

// ─── HTTP Client ────────────────────────────────
var httpClient *http.Client

func initHTTPClient() {
	transport := &http.Transport{
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 32,
		IdleConnTimeout:     90 * time.Second,
	}

	if socks5Proxy != "" {
		if p, err := url.Parse(socks5Proxy); err == nil && p.Scheme == "socks5" {
			if dialer, err := proxy.SOCKS5("tcp", p.Host, nil, proxy.Direct); err == nil {
				if cd, ok := dialer.(proxy.ContextDialer); ok {
					transport.DialContext = cd.DialContext
					fmt.Printf("[S5] SOCKS5 %s\n", socks5Proxy)
				}
			}
		}
	}
	httpClient = &http.Client{Transport: transport, Timeout: 20 * time.Second}
}

// ─── Refresh ────────────────────────────────────
func refreshChannels() {
	var all []Channel
	for _, src := range sources {
		resp, err := httpClient.Get(src.URL)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var parsed []Channel
		if src.Format == "m3u" {
			parsed = parseM3U(string(body))
		} else {
			parsed = parseTXT(string(body))
		}
		all = append(all, parsed...)
	}

	seen := map[string]bool{}
	var merged []Channel
	for _, ch := range all {
		if !seen[ch.Name] {
			seen[ch.Name] = true
			merged = append(merged, ch)
		}
	}

	channelsMu.Lock()
	channels = merged
	channelsMu.Unlock()
	fmt.Printf("[OK] %d channels\n", len(merged))
}

// ─── Helpers ────────────────────────────────────
func hostPrefix(r *http.Request) string {
	if x := r.Header.Get("X-Forwarded-Host"); x != "" {
		return x
	}
	return r.Host
}

func proxyURL(ch Channel, host string) string {
	if strings.HasPrefix(ch.URL, "rtmp") {
		return ch.URL
	}
	return fmt.Sprintf("http://%s/proxy/%s", host, url.PathEscape(ch.Name))
}

func b64url(s string) string {
	return strings.TrimRight(base64.URLEncoding.EncodeToString([]byte(s)), "=")
}

func rewriteM3U(body, vpsHost, cdnBase string) string {
	// Rewrite absolute HTTP URLs
	re := regexp.MustCompile(`https?://[^\s\r\n#]+`)
	body = re.ReplaceAllStringFunc(body, func(m string) string {
		return fmt.Sprintf("http://%s/seg/%s", vpsHost, b64url(m))
	})
	// Rewrite relative paths
	var out []string
	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || t[0] == '#' || strings.HasPrefix(t, "/seg/") || strings.Contains(t, vpsHost) {
			out = append(out, line)
			continue
		}
		parsed, err := url.Parse(t)
		if err != nil || parsed.IsAbs() {
			out = append(out, line)
			continue
		}
		resolved, err := url.JoinPath(cdnBase, t)
		if err != nil {
			out = append(out, line)
			continue
		}
		out = append(out, fmt.Sprintf("http://%s/seg/%s", vpsHost, b64url(resolved)))
	}
	return strings.Join(out, "\n")
}

// ─── Handlers ───────────────────────────────────
func handleTVBox(w http.ResponseWriter, r *http.Request) {
	channelsMu.RLock()
	cc := make([]Channel, len(channels))
	copy(cc, channels)
	channelsMu.RUnlock()

	host := hostPrefix(r)
	lives := make([]map[string]string, len(cc))
	for i, ch := range cc {
		lives[i] = map[string]string{
			"name": ch.Name, "url": proxyURL(ch, host), "group": ch.Group,
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]any{"lives": lives})
}

func handleTXT(w http.ResponseWriter, r *http.Request) {
	channelsMu.RLock()
	cc := make([]Channel, len(channels))
	copy(cc, channels)
	channelsMu.RUnlock()

	host := hostPrefix(r)
	groups := map[string][]string{}
	for _, ch := range cc {
		g := ch.Group
		groups[g] = append(groups[g], fmt.Sprintf("%s,%s", ch.Name, proxyURL(ch, host)))
	}
	var gn []string
	for g := range groups {
		gn = append(gn, g)
	}
	sort.Strings(gn)
	var lines []string
	for _, g := range gn {
		lines = append(lines, g+",#genre#")
		lines = append(lines, groups[g]...)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(strings.Join(lines, "\n")))
}

func handleM3U(w http.ResponseWriter, r *http.Request) {
	channelsMu.RLock()
	cc := make([]Channel, len(channels))
	copy(cc, channels)
	channelsMu.RUnlock()

	host := hostPrefix(r)
	w.Header().Set("Content-Type", "audio/x-mpegurl; charset=utf-8")
	w.Write([]byte("#EXTM3U\n"))
	for _, ch := range cc {
		u := proxyURL(ch, host)
		fmt.Fprintf(w, "#EXTINF:-1 group-title=\"%s\" tvg-name=\"%s\",%s\n%s\n", ch.Group, ch.Name, ch.Name, u)
	}
}

func handleProxy(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/proxy/")
	name, _ = url.PathUnescape(name)
	if name == "" {
		http.Error(w, "Not found", 404)
		return
	}

	channelsMu.RLock()
	var ch *Channel
	for i := range channels {
		if channels[i].Name == name {
			ch = &channels[i]
			break
		}
	}
	channelsMu.RUnlock()
	if ch == nil {
		http.Error(w, "Not found", 404)
		return
	}

	resp, err := httpClient.Get(ch.URL)
	if err != nil {
		http.Error(w, "Proxy failed", 502)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "Proxy failed", 502)
		return
	}

	ct := resp.Header.Get("content-type")
	host := hostPrefix(r)

	// Check if m3u8
	if strings.Contains(ct, "mpegurl") || strings.Contains(ct, "x-mpegurl") || (len(body) > 10 && strings.Contains(string(body[:10]), "EXTM3U")) {
		cdnBase := ch.URL[:strings.LastIndex(ch.URL, "/")+1]
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Write([]byte(rewriteM3U(string(body), host, cdnBase)))
		return
	}
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(body)
}

func handleSeg(w http.ResponseWriter, r *http.Request) {
	b64 := strings.TrimPrefix(r.URL.Path, "/seg/")
	if b64 == "" {
		http.Error(w, "Missing", 400)
		return
	}
	decoded, err := base64.URLEncoding.WithPadding(base64.NoPadding).DecodeString(b64)
	if err != nil {
		http.Error(w, "Bad encoding", 400)
		return
	}
	targetURL := string(decoded)

	resp, err := httpClient.Get(targetURL)
	if err != nil {
		http.Error(w, "Proxy failed", 502)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "Proxy failed", 502)
		return
	}

	ct := resp.Header.Get("content-type")
	host := hostPrefix(r)

	if strings.Contains(ct, "mpegurl") || strings.Contains(ct, "x-mpegurl") || (len(body) > 10 && strings.Contains(string(body[:10]), "EXTM3U")) {
		cdnBase := targetURL[:strings.LastIndex(targetURL, "/")+1]
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Write([]byte(rewriteM3U(string(body), host, cdnBase)))
		return
	}
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(body)
}

func handleStatus(w http.ResponseWriter, r *http.Request) {
	channelsMu.RLock()
	n := len(channels)
	channelsMu.RUnlock()
	json.NewEncoder(w).Encode(map[string]any{
		"channels": n,
		"updated":  time.Now().UTC().Format(time.RFC3339),
	})
}

// ─── Main ───────────────────────────────────────
func main() {
	initHTTPClient()
	os.MkdirAll(dataDir, 0755)
	refreshChannels()
	go func() {
		for range time.NewTicker(3 * time.Hour).C {
			refreshChannels()
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/tvbox.json", handleTVBox)
	mux.HandleFunc("/taiwan.txt", handleTXT)
	mux.HandleFunc("/taiwan.m3u", handleM3U)
	mux.HandleFunc("/proxy/", handleProxy)
	mux.HandleFunc("/seg/", handleSeg)
	mux.HandleFunc("/status", handleStatus)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("TaiwanTV - /tvbox.json /taiwan.txt /taiwan.m3u"))
	})

	addr := fmt.Sprintf(":%s", port)
	fmt.Printf("TaiwanTV -> http://0.0.0.0%s/tvbox.json\n", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		fmt.Fprintf(os.Stderr, "Fatal: %v\n", err)
		os.Exit(1)
	}
}
