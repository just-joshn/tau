/* Independent isolation probe. This never reads Claude data or runs Claude. */
#include <arpa/inet.h>
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static int open_read(const char *path) {
  int fd = open(path, O_RDONLY); if (fd < 0) return errno;
  char byte; int result = read(fd, &byte, 1) < 0 ? errno : 0; close(fd); return result;
}
static int open_write(const char *path) {
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600); if (fd < 0) return errno;
  int result = write(fd, "canary", 6) == 6 ? 0 : errno; close(fd); return result;
}
static int list_directory(const char *path) {
  errno = 0; DIR *dir = opendir(path); if (!dir) return errno;
  struct dirent *entry = readdir(dir); int result = entry ? 0 : errno;
  closedir(dir); return result;
}
static int tcp4(const char *ip, int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0); if (fd < 0) return errno;
  struct sockaddr_in address; memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET; address.sin_port = htons((unsigned short)port); inet_pton(AF_INET, ip, &address.sin_addr);
  int result = connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0 ? errno : 0; close(fd); return result;
}
static int tcp6(void) {
  int fd = socket(AF_INET6, SOCK_STREAM, 0); if (fd < 0) return errno;
  struct sockaddr_in6 address; memset(&address, 0, sizeof(address));
  address.sin6_family = AF_INET6; address.sin6_port = htons(443); inet_pton(AF_INET6, "2001:db8::1", &address.sin6_addr);
  int result = connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0 ? errno : 0; close(fd); return result;
}
static int udp4(void) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0); if (fd < 0) return errno;
  struct sockaddr_in address; memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET; address.sin_port = htons(53); inet_pton(AF_INET, "198.51.100.1", &address.sin_addr);
  int result = sendto(fd, "", 0, 0, (struct sockaddr *)&address, sizeof(address)) < 0 ? errno : 0; close(fd); return result;
}
static int unix_socket(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0); if (fd < 0) return errno;
  struct sockaddr_un address; memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
  snprintf(address.sun_path, sizeof(address.sun_path), "%s", path);
  int result = connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0 ? errno : 0; close(fd); return result;
}
int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "child") == 0) return open_read(argv[2]) == EPERM ? 0 : 4;
  if (argc != 10) return 2;
  char expected_home[4096]; snprintf(expected_home, sizeof(expected_home), "%s/home", argv[1]);
  int dummy_home = getenv("HOME") && strcmp(getenv("HOME"), expected_home) == 0;
  int icu_read = open_read("/usr/share/icu/icudt78l.dat");
  int host_read = open_read(argv[2]), alias_read = open_read(argv[3]), outside_write = open_write(argv[4]);
  int good = tcp4("127.0.0.1", atoi(argv[5])), bad = tcp4("127.0.0.1", atoi(argv[6]));
  int external4 = tcp4("198.51.100.1", 443), external6 = tcp6(), dns = udp4(), unix_result = unix_socket(argv[7]);
  struct stat info; int metadata = stat(argv[2], &info) < 0 ? errno : 0;
  int private_metadata = lstat("/private", &info) < 0 ? errno : 0;
  int tmp_metadata = lstat("/private/tmp", &info) < 0 ? errno : 0;
  int private_listing = list_directory("/private"), tmp_listing = list_directory("/private/tmp");
  int expected_metadata = strcmp(argv[9], "1") == 0 ? 0 : EPERM;
  char allowed[4096]; snprintf(allowed, sizeof(allowed), "%s/work/allowed.txt", argv[1]); int inside_read = open_read(allowed);
  snprintf(allowed, sizeof(allowed), "%s/work/written.txt", argv[1]); int inside_write = open_write(allowed);
  mach_port_t port = MACH_PORT_NULL; kern_return_t keychain = bootstrap_look_up(bootstrap_port, "com.apple.securityd", &port);
  if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
  int child_status = -1; pid_t child = fork();
  if (child == 0) { execl(argv[8], argv[8], "child", argv[2], (char *)NULL); _exit(5); }
  if (child > 0) { int status = 0; waitpid(child, &status, 0); child_status = WIFEXITED(status) ? WEXITSTATUS(status) : -2; }
  printf("{\"private_metadata_errno\":%d,\"tmp_metadata_errno\":%d,\"private_listing_errno\":%d,\"tmp_listing_errno\":%d,\"icu_data_errno\":%d,\"dummy_home\":%d,\"host_read_errno\":%d,\"alias_read_errno\":%d,\"host_metadata_errno\":%d,\"outside_write_errno\":%d,\"inside_read_errno\":%d,\"inside_write_errno\":%d,\"allowed_loopback_errno\":%d,\"other_loopback_errno\":%d,\"external_ipv4_errno\":%d,\"external_ipv6_errno\":%d,\"dns_udp_errno\":%d,\"unix_socket_errno\":%d,\"keychain_lookup_result\":%d,\"child_inherits_denial\":%d}\n",private_metadata,tmp_metadata,private_listing,tmp_listing,icu_read,dummy_home,host_read,alias_read,metadata,outside_write,inside_read,inside_write,good,bad,external4,external6,dns,unix_result,keychain,child_status);
  return private_metadata == expected_metadata && tmp_metadata == expected_metadata && private_listing == EPERM && tmp_listing == EPERM && icu_read == 0 && dummy_home && host_read == EPERM && alias_read == EPERM && metadata == EPERM && outside_write == EPERM && inside_read == 0 && inside_write == 0 && good == 0 && bad == EPERM && external4 == EPERM && external6 == EPERM && dns == EPERM && unix_result == EPERM && keychain != KERN_SUCCESS && child_status == 0 ? 0 : 3;
}
