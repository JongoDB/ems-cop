package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("SERVICE_PORT")
	if port == "" {
		port = "3000"
	}
	name := os.Getenv("SERVICE_NAME")
	if name == "" {
		name = "service"
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": name})
	})
	log.Printf("[%s] Starting on :%s", name, port)
	if err := http.ListenAndServe(fmt.Sprintf(":%s", port), mux); err != nil {
		log.Fatalf("[%s] Failed: %v", name, err)
	}
}
