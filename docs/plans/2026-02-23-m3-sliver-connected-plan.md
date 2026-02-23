# M3 Sliver Connected — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect the C2 Gateway to Sliver's gRPC API so operators can list sessions, execute commands, and open interactive shells from the browser, with every action logged to the audit trail.

**Architecture:** The c2-gateway imports Sliver's protobuf definitions and connects via mTLS gRPC using the auto-generated operator config. Interactive shells use a direct WebSocket on c2-gateway (no NATS hop). The frontend gets a new `/c2` page with session list, xterm.js terminal, and quick-command panel.

**Tech Stack:** Go + `bishopfox/sliver/protobuf` + `gorilla/websocket` + `nats.go` for backend. React + xterm.js for frontend.

**Design doc:** `docs/plans/2026-02-23-m3-sliver-connected-design.md`

---

## Task 1: Add Go Dependencies to c2-gateway

**Files:**
- Modify: `services/c2-gateway/go.mod`

**Step 1: Add dependencies**

```bash
cd services/c2-gateway
go get github.com/bishopfox/sliver/protobuf/rpcpb@latest
go get github.com/bishopfox/sliver/protobuf/clientpb@latest
go get github.com/bishopfox/sliver/protobuf/sliverpb@latest
go get github.com/bishopfox/sliver/protobuf/commonpb@latest
go get github.com/gorilla/websocket@latest
go get github.com/nats-io/nats.go@latest
go get google.golang.org/grpc@latest
```

Note: The Sliver protobuf pull is large (~2GB of transitive deps). This will take a few minutes. If `go get` for the Sliver protobuf fails due to module size or version issues, try pinning to a specific Sliver release tag: `go get github.com/bishopfox/sliver/protobuf@v1.5.42` (or whatever the latest release tag is — check `https://github.com/BishopFox/sliver/releases`).

**Step 2: Verify it compiles**

```bash
cd services/c2-gateway && go build -o /dev/null .
```

Expected: builds successfully (the existing code doesn't reference the new imports yet, so no errors).

**Step 3: Commit**

```bash
git add services/c2-gateway/go.mod services/c2-gateway/go.sum
git commit -m "Add Sliver protobuf, gorilla/websocket, nats.go deps to c2-gateway"
```

---

## Task 2: Implement Sliver gRPC Connection

**Files:**
- Modify: `services/c2-gateway/main.go`

**Step 1: Add imports and operator config parsing**

At the top of `main.go`, add these imports:

```go
import (
    "crypto/tls"
    "crypto/x509"
    "encoding/pem"
    "io"
    "log/slog"
    "sync"

    "github.com/nats-io/nats.go"
    "github.com/gorilla/websocket"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials"

    "github.com/bishopfox/sliver/protobuf/rpcpb"
    "github.com/bishopfox/sliver/protobuf/clientpb"
    "github.com/bishopfox/sliver/protobuf/sliverpb"
    "github.com/bishopfox/sliver/protobuf/commonpb"
)
```

Add the operator config struct and parsing function:

```go
type OperatorConfig struct {
    Operator      string `json:"operator"`
    LHost         string `json:"lhost"`
    LPort         int    `json:"lport"`
    CACertificate string `json:"ca_certificate"`
    PrivateKey    string `json:"private_key"`
    Certificate   string `json:"certificate"`
}

func loadOperatorConfig(path string) (*OperatorConfig, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("read operator config: %w", err)
    }
    var cfg OperatorConfig
    if err := json.Unmarshal(data, &cfg); err != nil {
        return nil, fmt.Errorf("parse operator config: %w", err)
    }
    return &cfg, nil
}

func (c *OperatorConfig) TLSConfig() (*tls.Config, error) {
    certPEM := []byte(c.Certificate)
    keyPEM := []byte(c.PrivateKey)
    cert, err := tls.X509KeyPair(certPEM, keyPEM)
    if err != nil {
        return nil, fmt.Errorf("parse client cert: %w", err)
    }

    caCertPool := x509.NewCertPool()
    caCertPool.AppendCertsFromPEM([]byte(c.CACertificate))

    return &tls.Config{
        RootCAs:      caCertPool,
        Certificates: []tls.Certificate{cert},
        InsecureSkipVerify: true, // Sliver uses self-signed certs
    }, nil
}
```

**Step 2: Rewrite SliverProvider with real gRPC fields**

Replace the existing `SliverProvider` struct and `Connect`/`Disconnect` methods:

```go
type SliverProvider struct {
    config    ProviderConfig
    conn      *grpc.ClientConn
    rpc       rpcpb.SliverRPCClient
    mu        sync.RWMutex
    connected bool
    logger    *slog.Logger
}

func NewSliverProvider(logger *slog.Logger) *SliverProvider {
    return &SliverProvider{logger: logger}
}

func (p *SliverProvider) Name() string { return "sliver" }

func (p *SliverProvider) IsConnected() bool {
    p.mu.RLock()
    defer p.mu.RUnlock()
    return p.connected
}

func (p *SliverProvider) Connect(ctx context.Context, config ProviderConfig) error {
    p.config = config

    opConfig, err := loadOperatorConfig(config.OperatorConfig)
    if err != nil {
        return fmt.Errorf("load operator config: %w", err)
    }

    tlsConfig, err := opConfig.TLSConfig()
    if err != nil {
        return fmt.Errorf("build TLS config: %w", err)
    }

    target := fmt.Sprintf("%s:%d", config.Host, config.Port)
    p.logger.Info("connecting to sliver", "target", target, "operator", opConfig.Operator)

    conn, err := grpc.DialContext(ctx, target,
        grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)),
    )
    if err != nil {
        return fmt.Errorf("grpc dial: %w", err)
    }

    p.mu.Lock()
    p.conn = conn
    p.rpc = rpcpb.NewSliverRPCClient(conn)
    p.connected = true
    p.mu.Unlock()

    p.logger.Info("connected to sliver", "target", target)
    return nil
}

func (p *SliverProvider) Disconnect() error {
    p.mu.Lock()
    defer p.mu.Unlock()
    if p.conn != nil {
        p.connected = false
        return p.conn.Close()
    }
    return nil
}
```

**Step 3: Update main() with slog, NATS, and retry loop**

Replace the existing `main()` function. Key changes:
- Switch from `log` to `slog` (consistent with other Go services)
- Add NATS connection
- Add background retry loop for Sliver connection
- Pass logger and NATS to the server

```go
func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    port := os.Getenv("SERVICE_PORT")
    if port == "" {
        port = "3005"
    }

    // NATS
    natsURL := os.Getenv("NATS_URL")
    if natsURL == "" {
        natsURL = "nats://localhost:4222"
    }
    nc, err := nats.Connect(natsURL,
        nats.RetryOnFailedConnect(true),
        nats.MaxReconnects(-1),
        nats.ReconnectWait(2*time.Second),
    )
    if err != nil {
        logger.Error("failed to connect to nats", "error", err)
        os.Exit(1)
    }
    defer nc.Close()
    logger.Info("connected to nats")

    // Initialize Sliver provider
    provider := NewSliverProvider(logger)

    sliverHost := os.Getenv("SLIVER_GRPC_HOST")
    if sliverHost == "" {
        sliverHost = "sliver-server"
    }
    sliverPort := 31337

    providerConfig := ProviderConfig{
        Host:           sliverHost,
        Port:           sliverPort,
        OperatorConfig: os.Getenv("SLIVER_OPERATOR_CONFIG"),
    }

    // Try connecting — if it fails, retry in background
    if err := provider.Connect(context.Background(), providerConfig); err != nil {
        logger.Warn("initial sliver connection failed, will retry", "error", err)
        go func() {
            for {
                time.Sleep(10 * time.Second)
                if provider.IsConnected() {
                    return
                }
                if err := provider.Connect(context.Background(), providerConfig); err != nil {
                    logger.Warn("sliver reconnect failed", "error", err)
                } else {
                    logger.Info("sliver reconnected successfully")
                    return
                }
            }
        }()
    }

    // Start HTTP server
    server := NewC2GatewayServer(provider, port, nc, logger)

    // Graceful shutdown
    go func() {
        sigCh := make(chan os.Signal, 1)
        signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
        <-sigCh
        logger.Info("shutting down")
        provider.Disconnect()
        nc.Close()
        os.Exit(0)
    }()

    logger.Info("c2-gateway starting", "port", port)
    if err := server.Start(); err != nil {
        logger.Error("server failed", "error", err)
        os.Exit(1)
    }
}
```

**Step 4: Update C2GatewayServer to hold NATS and logger**

```go
type C2GatewayServer struct {
    provider C2Provider
    port     string
    nc       *nats.Conn
    logger   *slog.Logger
}

func NewC2GatewayServer(provider C2Provider, port string, nc *nats.Conn, logger *slog.Logger) *C2GatewayServer {
    return &C2GatewayServer{provider: provider, port: port, nc: nc, logger: logger}
}
```

**Step 5: Verify it compiles**

```bash
cd services/c2-gateway && go build -o /dev/null .
```

Expected: compiles. There will be "imported and not used" errors if `clientpb`, `sliverpb`, `commonpb`, `websocket`, `pem`, `io` aren't used yet — add blank identifiers `_ = ...` temporarily or wait until Task 3 adds the usages.

**Step 6: Commit**

```bash
git add services/c2-gateway/
git commit -m "Implement Sliver gRPC connection with mTLS and retry loop"
```

---

## Task 3: Implement Provider Methods (ListSessions, ListImplants, ListListeners)

**Files:**
- Modify: `services/c2-gateway/main.go`

**Step 1: Implement ListSessions**

Replace the existing stub:

```go
func (p *SliverProvider) ListSessions(ctx context.Context, filter *SessionFilter) ([]Session, error) {
    if !p.IsConnected() {
        return nil, fmt.Errorf("not connected to sliver")
    }
    resp, err := p.rpc.GetSessions(ctx, &commonpb.Empty{})
    if err != nil {
        return nil, fmt.Errorf("get sessions: %w", err)
    }

    sessions := make([]Session, 0, len(resp.Sessions))
    for _, s := range resp.Sessions {
        sessions = append(sessions, Session{
            ID:          fmt.Sprintf("%d", s.ID),
            ImplantID:   s.Name,
            Hostname:    s.Hostname,
            OS:          s.OS,
            RemoteAddr:  s.RemoteAddress,
            Transport:   s.Transport,
            IsAlive:     !s.IsDead,
            LastMessage: time.Unix(s.LastCheckin, 0),
        })
    }
    return sessions, nil
}
```

Note: Sliver's `Session.ID` is a `uint32` in some versions and a `string` in others. Check the actual protobuf type after `go get` — if it's a string, use it directly instead of `fmt.Sprintf("%d", s.ID)`.

**Step 2: Implement ListImplants**

Replace the existing stub. Sliver calls them "implant builds" and "beacons":

```go
func (p *SliverProvider) ListImplants(ctx context.Context, filter *ImplantFilter) ([]Implant, error) {
    if !p.IsConnected() {
        return nil, fmt.Errorf("not connected to sliver")
    }

    // Get implant builds
    builds, err := p.rpc.ImplantBuilds(ctx, &commonpb.Empty{})
    if err != nil {
        return nil, fmt.Errorf("get implant builds: %w", err)
    }

    var implants []Implant
    for name, build := range builds.Configs {
        implants = append(implants, Implant{
            ID:        build.ID,
            Name:      name,
            OS:        build.GOOS,
            Arch:      build.GOARCH,
            Transport: build.C2[0].URL, // first C2 URL
            Status:    "built",
        })
    }

    // Get beacons (async implants)
    beacons, err := p.rpc.GetBeacons(ctx, &commonpb.Empty{})
    if err != nil {
        p.logger.Warn("failed to get beacons", "error", err)
    } else {
        for _, b := range beacons.Beacons {
            implants = append(implants, Implant{
                ID:          b.ID,
                Name:        b.Name,
                OS:          b.OS,
                Arch:        b.Arch,
                Transport:   b.Transport,
                Hostname:    b.Hostname,
                RemoteAddr:  b.RemoteAddress,
                LastCheckin: time.Unix(b.LastCheckin, 0),
                Status:      "active",
            })
        }
    }

    return implants, nil
}
```

Note: The Sliver protobuf types may differ slightly from what's shown above. After pulling the dependency, inspect the actual types in `clientpb` and adjust field names accordingly. The key pattern is: call the RPC, iterate the response, map to EMS types.

**Step 3: Implement ListListeners**

```go
func (p *SliverProvider) ListListeners(ctx context.Context) ([]Listener, error) {
    if !p.IsConnected() {
        return nil, fmt.Errorf("not connected to sliver")
    }
    jobs, err := p.rpc.GetJobs(ctx, &commonpb.Empty{})
    if err != nil {
        return nil, fmt.Errorf("get jobs: %w", err)
    }

    listeners := make([]Listener, 0, len(jobs.Active))
    for _, j := range jobs.Active {
        listeners = append(listeners, Listener{
            ID:        fmt.Sprintf("%d", j.ID),
            Protocol:  j.Name,
            Host:      j.Domains[0], // may need fallback
            Port:      int(j.Port),
            IsRunning: true,
        })
    }
    return listeners, nil
}
```

**Step 4: Verify it compiles**

```bash
cd services/c2-gateway && go build -o /dev/null .
```

**Step 5: Commit**

```bash
git add services/c2-gateway/
git commit -m "Implement ListSessions, ListImplants, ListListeners via Sliver gRPC"
```

---

## Task 4: Implement ExecuteTask (Command Routing)

**Files:**
- Modify: `services/c2-gateway/main.go`

**Step 1: Implement ExecuteTask with command routing**

Replace the existing stub. This routes each command string to the appropriate Sliver RPC:

```go
func (p *SliverProvider) ExecuteTask(ctx context.Context, sessionID string, task C2Task) (*TaskResult, error) {
    if !p.IsConnected() {
        return nil, fmt.Errorf("not connected to sliver")
    }

    started := time.Now()
    req := &commonpb.Request{SessionID: sessionID, Timeout: 30}

    var output string
    var taskErr string

    switch task.Command {
    case "ls":
        path, _ := task.Arguments["path"].(string)
        if path == "" {
            path = "."
        }
        resp, err := p.rpc.Ls(ctx, &sliverpb.LsReq{Path: path, Request: req})
        if err != nil {
            taskErr = err.Error()
        } else if resp.Response != nil && resp.Response.Err != "" {
            taskErr = resp.Response.Err
        } else {
            output = formatLsOutput(resp)
        }

    case "ps":
        resp, err := p.rpc.Ps(ctx, &sliverpb.PsReq{Request: req})
        if err != nil {
            taskErr = err.Error()
        } else {
            output = formatPsOutput(resp)
        }

    case "pwd":
        resp, err := p.rpc.Pwd(ctx, &sliverpb.PwdReq{Request: req})
        if err != nil {
            taskErr = err.Error()
        } else {
            output = resp.Path
        }

    case "whoami":
        resp, err := p.rpc.Whoami(ctx, &sliverpb.WhoamiReq{Request: req})
        if err != nil {
            taskErr = err.Error()
        } else {
            output = resp.Output
        }

    case "ifconfig":
        resp, err := p.rpc.Ifconfig(ctx, &sliverpb.IfconfigReq{Request: req})
        if err != nil {
            taskErr = err.Error()
        } else {
            output = formatIfconfigOutput(resp)
        }

    case "netstat":
        resp, err := p.rpc.Netstat(ctx, &sliverpb.NetstatReq{Request: req})
        if err != nil {
            taskErr = err.Error()
        } else {
            output = formatNetstatOutput(resp)
        }

    case "execute":
        path, _ := task.Arguments["path"].(string)
        args, _ := task.Arguments["args"].([]interface{})
        var strArgs []string
        for _, a := range args {
            if s, ok := a.(string); ok {
                strArgs = append(strArgs, s)
            }
        }
        resp, err := p.rpc.Execute(ctx, &sliverpb.ExecuteReq{
            Path:    path,
            Args:    strArgs,
            Output:  true,
            Request: req,
        })
        if err != nil {
            taskErr = err.Error()
        } else {
            output = string(resp.Stdout)
            if len(resp.Stderr) > 0 {
                output += "\nSTDERR:\n" + string(resp.Stderr)
            }
        }

    case "download":
        path, _ := task.Arguments["path"].(string)
        resp, err := p.rpc.Download(ctx, &sliverpb.DownloadReq{Path: path, Request: req})
        if err != nil {
            taskErr = err.Error()
        } else {
            output = fmt.Sprintf("Downloaded %d bytes from %s", len(resp.Data), path)
        }

    case "screenshot":
        resp, err := p.rpc.Screenshot(ctx, &sliverpb.ScreenshotReq{Request: req})
        if err != nil {
            taskErr = err.Error()
        } else {
            output = fmt.Sprintf("Screenshot captured: %d bytes", len(resp.Data))
        }

    default:
        taskErr = fmt.Sprintf("unsupported command: %s", task.Command)
    }

    return &TaskResult{
        TaskID:    fmt.Sprintf("%d", time.Now().UnixNano()),
        Command:   task.Command,
        Output:    output,
        Error:     taskErr,
        StartedAt: started,
        EndedAt:   time.Now(),
    }, nil
}
```

**Step 2: Add output formatting helpers**

```go
func formatLsOutput(resp *sliverpb.Ls) string {
    var sb strings.Builder
    sb.WriteString(fmt.Sprintf("Directory: %s\n\n", resp.Path))
    for _, f := range resp.Files {
        mode := "f"
        if f.IsDir {
            mode = "d"
        }
        sb.WriteString(fmt.Sprintf("%s %10d  %s\n", mode, f.Size, f.Name))
    }
    return sb.String()
}

func formatPsOutput(resp *sliverpb.Ps) string {
    var sb strings.Builder
    sb.WriteString(fmt.Sprintf("%-8s %-8s %-20s %s\n", "PID", "PPID", "OWNER", "EXECUTABLE"))
    for _, p := range resp.Processes {
        sb.WriteString(fmt.Sprintf("%-8d %-8d %-20s %s\n", p.Pid, p.Ppid, p.Owner, p.Executable))
    }
    return sb.String()
}

func formatIfconfigOutput(resp *sliverpb.Ifconfig) string {
    var sb strings.Builder
    for _, iface := range resp.NetInterfaces {
        sb.WriteString(fmt.Sprintf("%s:\n", iface.Name))
        for _, addr := range iface.IPAddresses {
            sb.WriteString(fmt.Sprintf("  %s\n", addr))
        }
        sb.WriteString(fmt.Sprintf("  MAC: %s\n\n", iface.MAC))
    }
    return sb.String()
}

func formatNetstatOutput(resp *sliverpb.Netstat) string {
    var sb strings.Builder
    sb.WriteString(fmt.Sprintf("%-8s %-25s %-25s %-10s\n", "PROTO", "LOCAL", "REMOTE", "STATE"))
    for _, e := range resp.Entries {
        local := fmt.Sprintf("%s:%d", e.LocalAddr.Ip, e.LocalAddr.Port)
        remote := fmt.Sprintf("%s:%d", e.RemoteAddr.Ip, e.RemoteAddr.Port)
        sb.WriteString(fmt.Sprintf("%-8s %-25s %-25s %-10s\n", e.Protocol, local, remote, e.SkState))
    }
    return sb.String()
}
```

Note: These formatters reference Sliver protobuf field names. After pulling the actual protos, adjust field names to match (e.g., `f.IsDir` might be `f.IsDir` or `f.GetIsDir()`). The pattern stays the same.

**Step 3: Verify it compiles**

```bash
cd services/c2-gateway && go build -o /dev/null .
```

**Step 4: Commit**

```bash
git add services/c2-gateway/
git commit -m "Implement ExecuteTask with command routing to Sliver RPCs"
```

---

## Task 5: Implement NATS Audit Event Publishing

**Files:**
- Modify: `services/c2-gateway/main.go`

**Step 1: Add audit event helper and publish from handlers**

Add an audit event struct and publish helper:

```go
type AuditEvent struct {
    EventType     string `json:"event_type"`
    ActorID       string `json:"actor_id"`
    ActorUsername  string `json:"actor_username"`
    ActorIP       string `json:"actor_ip"`
    SessionID     string `json:"session_id"`
    ResourceType  string `json:"resource_type"`
    ResourceID    string `json:"resource_id"`
    Action        string `json:"action"`
    Details       string `json:"details"`
    Timestamp     string `json:"timestamp"`
}

func (s *C2GatewayServer) publishAudit(eventType string, r *http.Request, resourceID, action, details string) {
    event := AuditEvent{
        EventType:    eventType,
        ActorID:      r.Header.Get("X-User-ID"),
        ActorUsername: r.Header.Get("X-User-Roles"), // ForwardAuth sets this
        ActorIP:      r.RemoteAddr,
        ResourceType: "c2_session",
        ResourceID:   resourceID,
        Action:       action,
        Details:      details,
        Timestamp:    time.Now().UTC().Format(time.RFC3339Nano),
    }
    data, _ := json.Marshal(event)
    if err := s.nc.Publish(eventType, data); err != nil {
        s.logger.Error("failed to publish audit event", "event", eventType, "error", err)
    }
}
```

**Step 2: Add audit publishing to handleExecuteTask**

In `handleExecuteTask`, after the task executes successfully, add:

```go
// After getting the result, publish audit event
detailsJSON, _ := json.Marshal(task)
s.publishAudit("c2.command_executed", r, sessionID, task.Command, string(detailsJSON))
```

**Step 3: Verify it compiles**

```bash
cd services/c2-gateway && go build -o /dev/null .
```

**Step 4: Commit**

```bash
git add services/c2-gateway/
git commit -m "Add NATS audit event publishing for C2 commands"
```

---

## Task 6: Implement WebSocket Shell Handler

**Files:**
- Modify: `services/c2-gateway/main.go`

**Step 1: Implement OpenSession on SliverProvider**

Replace the stub. This opens a shell on the target and returns a stream wrapper:

```go
type SliverSessionStream struct {
    tunnelID uint64
    rpc      rpcpb.SliverRPCClient
    stream   rpcpb.SliverRPC_TunnelDataClient
    cancel   context.CancelFunc
}

func (s *SliverSessionStream) Send(input string) error {
    return s.stream.Send(&sliverpb.TunnelData{
        TunnelID: s.tunnelID,
        Data:     []byte(input),
    })
}

func (s *SliverSessionStream) Recv() (string, error) {
    data, err := s.stream.Recv()
    if err != nil {
        return "", err
    }
    return string(data.Data), nil
}

func (s *SliverSessionStream) Close() error {
    s.cancel()
    return s.stream.CloseSend()
}

func (p *SliverProvider) OpenSession(ctx context.Context, sessionID string) (SessionStream, error) {
    if !p.IsConnected() {
        return nil, fmt.Errorf("not connected to sliver")
    }

    req := &commonpb.Request{SessionID: sessionID, Timeout: 0}
    shell, err := p.rpc.Shell(ctx, &sliverpb.ShellReq{
        Path:      "/bin/sh",
        EnablePTY: true,
        Request:   req,
    })
    if err != nil {
        return nil, fmt.Errorf("open shell: %w", err)
    }
    if shell.Response != nil && shell.Response.Err != "" {
        return nil, fmt.Errorf("shell error: %s", shell.Response.Err)
    }

    streamCtx, cancel := context.WithCancel(context.Background())
    stream, err := p.rpc.TunnelData(streamCtx)
    if err != nil {
        cancel()
        return nil, fmt.Errorf("open tunnel: %w", err)
    }

    return &SliverSessionStream{
        tunnelID: shell.TunnelID,
        rpc:      p.rpc,
        stream:   stream,
        cancel:   cancel,
    }, nil
}
```

Note: Sliver's tunnel API may work differently than shown. The key fields to look up in the actual protobuf after pulling deps are: `Shell` RPC return type (check for `TunnelID`), and how `TunnelData` streaming works. Adjust as needed.

**Step 2: Implement WebSocket handler**

Replace the `handleShellSession` stub:

```go
var upgrader = websocket.Upgrader{
    CheckOrigin: func(r *http.Request) bool { return true },
}

func (s *C2GatewayServer) handleShellSession(w http.ResponseWriter, r *http.Request) {
    sessionID := r.PathValue("sessionID")

    // Auth: check token from query param (WebSocket can't send custom headers)
    // ForwardAuth already validated on the HTTP upgrade, but as defense-in-depth
    // we check the user headers are present
    userID := r.Header.Get("X-User-ID")
    if userID == "" {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    // Upgrade to WebSocket
    ws, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        s.logger.Error("websocket upgrade failed", "error", err)
        return
    }
    defer ws.Close()

    // Open shell session on Sliver
    stream, err := s.provider.OpenSession(r.Context(), sessionID)
    if err != nil {
        s.logger.Error("failed to open shell session", "session", sessionID, "error", err)
        ws.WriteMessage(websocket.TextMessage, []byte("Error: "+err.Error()))
        return
    }
    defer stream.Close()

    // Publish session opened
    s.publishAudit("c2.session_opened", r, sessionID, "shell_open", "")

    // Read from Sliver → write to WebSocket
    done := make(chan struct{})
    go func() {
        defer close(done)
        for {
            output, err := stream.Recv()
            if err != nil {
                if err != io.EOF {
                    s.logger.Error("shell recv error", "error", err)
                }
                return
            }
            if err := ws.WriteMessage(websocket.TextMessage, []byte(output)); err != nil {
                return
            }
        }
    }()

    // Read from WebSocket → write to Sliver
    go func() {
        for {
            _, msg, err := ws.ReadMessage()
            if err != nil {
                return
            }
            if err := stream.Send(string(msg)); err != nil {
                return
            }
        }
    }()

    <-done

    // Publish session closed
    s.publishAudit("c2.session_closed", r, sessionID, "shell_close", "")
}
```

**Step 3: Verify it compiles**

```bash
cd services/c2-gateway && go build -o /dev/null .
```

**Step 4: Commit**

```bash
git add services/c2-gateway/
git commit -m "Implement WebSocket shell handler with Sliver tunnel proxy"
```

---

## Task 7: Update Health Endpoint

**Files:**
- Modify: `services/c2-gateway/main.go`

**Step 1: Update handleHealth to report Sliver status**

Replace the existing `handleHealth`:

```go
func (s *C2GatewayServer) handleHealth(w http.ResponseWriter, r *http.Request) {
    sp, ok := s.provider.(*SliverProvider)
    status := "ok"
    sliverConnected := false
    if ok {
        sliverConnected = sp.IsConnected()
    }
    if !sliverConnected {
        status = "degraded"
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]interface{}{
        "status":           status,
        "provider":         s.provider.Name(),
        "sliver_connected": sliverConnected,
        "time":             time.Now().UTC(),
    })
}
```

**Step 2: Verify and commit**

```bash
cd services/c2-gateway && go build -o /dev/null .
git add services/c2-gateway/
git commit -m "Update health endpoint to report Sliver connection status"
```

---

## Task 8: Build and Test c2-gateway Container

**Step 1: Build the c2-gateway container**

```bash
docker compose up -d --build c2-gateway
```

**Step 2: Check logs**

```bash
docker logs ems-c2-gateway --tail 20
```

Expected: either "connected to sliver" or "initial sliver connection failed, will retry" (if Sliver hasn't generated the operator config yet on a fresh startup).

**Step 3: Test health endpoint**

```bash
curl -s localhost:18080/api/v1/c2/health | jq .
```

Expected: JSON with `"provider": "sliver"` and `"sliver_connected": true/false`.

**Step 4: Test list sessions (authenticated)**

```bash
TOKEN=$(curl -s localhost:18080/api/v1/auth/login -d '{"username":"admin","password":"changeme"}' | jq -r .access_token)
curl -s -H "Authorization: Bearer $TOKEN" localhost:18080/api/v1/c2/sessions | jq .
```

Expected: empty array `[]` (no implants deployed yet), or sessions if any exist.

**Step 5: Test list listeners**

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:18080/api/v1/c2/listeners | jq .
```

Expected: array of active Sliver jobs (listeners).

**Step 6: Commit if any adjustments were needed**

```bash
git add services/c2-gateway/
git commit -m "Fix c2-gateway build issues from integration testing"
```

---

## Task 9: Create Frontend C2 Page

**Files:**
- Create: `frontend/src/pages/C2Page.tsx`

**Step 1: Create the C2 page component**

The page has three sections:
- Left sidebar: session list with status indicators
- Right panel tab 1: xterm.js terminal (Task 10)
- Right panel tab 2: quick-command buttons with output display

Create `frontend/src/pages/C2Page.tsx` with the session list, quick commands panel, and terminal placeholder. Use the same navbar pattern as TicketsPage (EMS-COP brand, TICKETS link, C2 link active, user badge, logout). Use `apiFetch` for API calls. Poll sessions every 10 seconds with `setInterval`.

Session list items show:
- Green/red dot for alive/dead
- Hostname
- OS
- Remote address
- Last message as relative time (e.g., "2m ago")

Quick commands: grid of buttons for `ls`, `ps`, `pwd`, `whoami`, `ifconfig`, `netstat`. Click calls `POST /api/v1/c2/sessions/{id}/execute` with `{command: "ls"}`. Output shown in `<pre>` block.

Terminal tab: placeholder div with `ref` for xterm.js (wired in Task 10).

Follow the same CSS class patterns used in TicketsPage (`.app-shell`, `.navbar`, `.main-content`, etc.).

**Step 2: Verify frontend compiles**

```bash
cd frontend && npm run build
```

**Step 3: Commit**

```bash
git add frontend/src/pages/C2Page.tsx
git commit -m "Create C2Page with session list and quick-command panel"
```

---

## Task 10: Create Terminal Panel with xterm.js

**Files:**
- Create: `frontend/src/components/TerminalPanel.tsx`
- Modify: `frontend/src/pages/C2Page.tsx` (import and use TerminalPanel)

**Step 1: Create TerminalPanel component**

```tsx
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelProps {
  sessionId: string
  accessToken: string
}

export default function TerminalPanel({ sessionId, accessToken }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!containerRef.current || !sessionId) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      theme: {
        background: '#0a0e14',
        foreground: '#c5cdd8',
        cursor: '#4dabf7',
        selectionBackground: '#1c2535',
      },
    })
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)
    fitAddon.fit()
    termRef.current = term

    // Connect WebSocket
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${location.host}/api/v1/c2/sessions/${sessionId}/shell?token=${accessToken}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      term.write('\r\n\x1b[32m[Connected to session ' + sessionId.slice(0, 8) + '...]\x1b[0m\r\n\r\n')
    }

    ws.onmessage = (e) => {
      term.write(e.data)
    }

    ws.onclose = () => {
      term.write('\r\n\x1b[31m[Session disconnected]\x1b[0m\r\n')
    }

    ws.onerror = () => {
      term.write('\r\n\x1b[31m[Connection error]\x1b[0m\r\n')
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })

    // Handle resize
    const handleResize = () => fitAddon.fit()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      ws.close()
      term.dispose()
    }
  }, [sessionId, accessToken])

  return <div ref={containerRef} className="terminal-container" />
}
```

**Step 2: Wire TerminalPanel into C2Page**

In `C2Page.tsx`, import and render the TerminalPanel when a session is selected and the Terminal tab is active. Pass `sessionId` and `accessToken` from the auth store.

**Step 3: Verify frontend compiles**

```bash
cd frontend && npm run build
```

**Step 4: Commit**

```bash
git add frontend/src/components/TerminalPanel.tsx frontend/src/pages/C2Page.tsx
git commit -m "Add xterm.js TerminalPanel with WebSocket shell connection"
```

---

## Task 11: Update App.tsx and Navigation

**Files:**
- Modify: `frontend/src/App.tsx` — add `/c2` route
- Modify: `frontend/src/pages/HomePage.tsx` — add C2 nav link
- Modify: `frontend/src/pages/TicketsPage.tsx` — add C2 nav link

**Step 1: Add route to App.tsx**

Add import and route:

```tsx
import C2Page from './pages/C2Page'

// Inside Routes:
<Route path="/c2" element={<ProtectedRoute><C2Page /></ProtectedRoute>} />
```

**Step 2: Add C2 nav link to HomePage**

In the navbar-left section of HomePage.tsx, after the TICKETS link, add:

```tsx
import { Shield, Ticket, LogOut, ChevronRight, Terminal } from 'lucide-react'

// In navbar-left, after the TICKETS link:
<Link to="/c2" className="navbar-link">
  <Terminal size={14} />
  C2
</Link>
```

**Step 3: Add C2 nav link to TicketsPage**

Same pattern — add Terminal import and C2 link to the navbar.

**Step 4: Verify frontend compiles**

```bash
cd frontend && npm run build
```

**Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/pages/HomePage.tsx frontend/src/pages/TicketsPage.tsx
git commit -m "Add /c2 route and C2 nav link to all pages"
```

---

## Task 12: Add C2 Page CSS Styles

**Files:**
- Modify: `frontend/src/index.css`

**Step 1: Add styles for the C2 page**

Add styles for:
- `.c2-layout` — split pane (sidebar + main panel)
- `.session-list` — left sidebar with session items
- `.session-item` — row with status dot, hostname, OS, address, time
- `.session-item.active` — selected state
- `.status-dot.alive` / `.status-dot.dead` — green/red indicators
- `.c2-panel` — right panel
- `.c2-tabs` — tab bar for Terminal / Commands
- `.c2-tab.active` — active tab highlight
- `.terminal-container` — full-height xterm container
- `.command-grid` — grid of quick-command buttons
- `.command-btn` — styled button
- `.command-output` — monospace pre block for command results

Follow the existing design system (dark theme, JetBrains Mono, `--color-*` CSS variables, `.app-shell` layout).

**Step 2: Verify frontend compiles and looks right**

```bash
cd frontend && npm run build
```

**Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "Add C2 page styles matching tactical dark theme"
```

---

## Task 13: Build, Deploy, and E2E Test

**Step 1: Rebuild all changed containers**

```bash
docker compose up -d --build c2-gateway frontend
```

**Step 2: Verify c2-gateway health**

```bash
curl -s localhost:18080/api/v1/c2/health | jq .
```

Expected: `sliver_connected: true` (or `false` with `"status": "degraded"` if Sliver hasn't generated operator config).

**Step 3: Test API through Traefik (authenticated)**

```bash
TOKEN=$(curl -s localhost:18080/api/v1/auth/login -d '{"username":"admin","password":"changeme"}' | jq -r .access_token)

# List sessions
curl -s -H "Authorization: Bearer $TOKEN" localhost:18080/api/v1/c2/sessions | jq .

# List listeners
curl -s -H "Authorization: Bearer $TOKEN" localhost:18080/api/v1/c2/listeners | jq .
```

**Step 4: Test unauthenticated access is blocked**

```bash
curl -s localhost:18080/api/v1/c2/sessions
```

Expected: 401 Unauthorized.

**Step 5: Test frontend in browser with Playwright**

```bash
npx playwright test --headed
```

Or manually: navigate to `http://localhost:18080`, login, click C2 in navbar, verify session list loads (empty is fine), verify Terminal and Commands tabs render.

**Step 6: Check audit events**

```bash
curl -s -H "Authorization: Bearer $TOKEN" "localhost:18080/api/v1/audit/events?event_type=c2.command_executed" | jq .
```

**Step 7: Final commit**

```bash
git add -A
git commit -m "M3 Sliver Connected — gRPC integration, WebSocket shell, C2 frontend page"
```

---

## Important Notes for the Implementer

1. **Sliver protobuf types will need adjustment.** The field names in this plan are based on documentation, not the actual generated Go code. After `go get`, inspect the types in your IDE or with `go doc` and adjust field names. The patterns are correct; the exact field names may differ.

2. **The Sliver operator config may not exist on first boot.** The entrypoint generates it, but there's a race condition — c2-gateway starts before Sliver finishes generating the config. The retry loop handles this.

3. **The `TunnelData` streaming API is Sliver's most complex feature.** If the tunnel approach doesn't work exactly as shown, check Sliver's own client source code at `github.com/BishopFox/sliver/client/command/shell` for the canonical implementation.

4. **WebSocket through Traefik** works out of the box — Traefik detects `Upgrade: websocket` headers and proxies the connection. No config changes needed.

5. **Docker build will be slow** the first time due to Sliver's large dependency tree. Subsequent builds use the Go module cache.
