/* Test-only raw byte relay. No SQL model, TCP, credentials, or configurable path.
 * Built statically for the local host architecture and copied only into the
 * task-owned container's tmpfs. It connects solely to that container's PG socket.
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

struct buffer {
    unsigned char bytes[65536];
    size_t offset;
    size_t length;
};

static int fill(int fd, struct buffer *buffer, int *eof) {
    ssize_t count = read(fd, buffer->bytes, sizeof(buffer->bytes));
    if (count > 0) {
        buffer->offset = 0;
        buffer->length = (size_t) count;
    } else if (count == 0) {
        *eof = 1;
    } else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
        return -1;
    }
    return 0;
}

static int drain(int fd, struct buffer *buffer) {
    ssize_t count = write(fd, buffer->bytes + buffer->offset, buffer->length);
    if (count > 0) {
        buffer->offset += (size_t) count;
        buffer->length -= (size_t) count;
    } else if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
        return -1;
    }
    return 0;
}

int main(void) {
    const char *path = "/var/run/postgresql/.s.PGSQL.5432";
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    struct buffer inbound = { .offset = 0, .length = 0 };
    struct buffer outbound = { .offset = 0, .length = 0 };
    int input_eof = 0, server_eof = 0, half_closed = 0;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0 || strlen(path) >= sizeof(address.sun_path)) return 1;
    memcpy(address.sun_path, path, strlen(path) + 1);
    if (connect(fd, (struct sockaddr *) &address, sizeof(address)) < 0) return 2;
    signal(SIGPIPE, SIG_IGN);
    int descriptors[] = { STDIN_FILENO, STDOUT_FILENO, fd };
    for (size_t i = 0; i < sizeof(descriptors) / sizeof(descriptors[0]); i++) {
        int flags = fcntl(descriptors[i], F_GETFL);
        if (flags < 0 || fcntl(descriptors[i], F_SETFL, flags | O_NONBLOCK) < 0) return 3;
    }
    while (!server_eof || outbound.length) {
        if (input_eof && !inbound.length && !half_closed) {
            if (shutdown(fd, SHUT_WR) < 0) return 4;
            half_closed = 1;
        }
        struct pollfd watches[] = {
            { .fd = (!input_eof && !inbound.length) ? STDIN_FILENO : -1, .events = POLLIN },
            { .fd = fd, .events = (!server_eof && !outbound.length ? POLLIN : 0) | (inbound.length ? POLLOUT : 0) },
            { .fd = outbound.length ? STDOUT_FILENO : -1, .events = POLLOUT }
        };
        int ready = poll(watches, 3, -1);
        if (ready < 0) { if (errno == EINTR) continue; return 5; }
        for (size_t i = 0; i < 3; i++) if (watches[i].revents & (POLLERR | POLLNVAL)) return 6;
        if (watches[0].revents & (POLLIN | POLLHUP)) {
            if (fill(STDIN_FILENO, &inbound, &input_eof) < 0) return 7;
        }
        if (!server_eof && !outbound.length && (watches[1].revents & (POLLIN | POLLHUP))) {
            if (fill(fd, &outbound, &server_eof) < 0) return 8;
        }
        if (inbound.length && (watches[1].revents & POLLOUT)) {
            if (drain(fd, &inbound) < 0) return 9;
        }
        if (outbound.length && (watches[2].revents & POLLOUT)) {
            if (drain(STDOUT_FILENO, &outbound) < 0) return 10;
        }
    }
    close(fd);
    return 0;
}
