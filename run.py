import os
import socket
import threading
import webbrowser

HOST = "0.0.0.0"
DEFAULT_PORT = int(os.environ.get("PORT", "5000"))

try:
    from waitress import serve as waitress_serve
except ModuleNotFoundError:
    waitress_serve = None


def choose_port(host, preferred_port, max_tries=10):
    """Return the preferred port when available, otherwise the next open one."""
    for port in range(preferred_port, preferred_port + max_tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(
        f"Could not find an open port between {preferred_port} and "
        f"{preferred_port + max_tries - 1}."
    )


def open_browser(port):
    """Opens the web browser to the application."""
    print(f"Opening browser to http://127.0.0.1:{port}")
    webbrowser.open_new(f"http://127.0.0.1:{port}")


if __name__ == "__main__":
    try:
        from app import app
    except ModuleNotFoundError as exc:
        print(
            "Missing Python dependency "
            f"'{exc.name}'. Install project requirements with:\n"
            "  python -m pip install -r requirements.txt"
        )
        raise SystemExit(1) from exc

    port = choose_port(HOST, DEFAULT_PORT)
    if port != DEFAULT_PORT:
        print(f"Port {DEFAULT_PORT} is in use. Starting on port {port} instead.")

    # Launch the browser shortly after the server starts listening.
    threading.Timer(1.5, open_browser, args=(port,)).start()

    try:
        if waitress_serve is not None:
            print("Starting production server with Waitress...")
            waitress_serve(app, host=HOST, port=port)
        else:
            print("Waitress is not installed. Falling back to Flask's built-in server.")
            app.run(host=HOST, port=port, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        print("Stopping server...")
        print("Server stopped.")
