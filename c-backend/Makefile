# rhythm-4k C backend —— 构建脚本
#
# 用法：
#   mingw32-make          构建 build/rhythm4k-server.exe
#   mingw32-make test     构建并运行单元测试
#   mingw32-make clean    清理
#
# 没有 make 的 Windows 用户可以直接运行 build.bat（内容等价）。

# ⚠️ 不能写 `CC ?= gcc` —— GNU Make 内置就把 CC 定义成了 `cc`，
#    变量"已定义"，`?=` 会静默失效，于是去调用一个不存在的 `cc`。
#    用 origin 判断：只有当 CC 还是 make 的内置默认值时才改，命令行传入的照样生效。
ifeq ($(origin CC),default)
CC := gcc
endif

CFLAGS   ?= -std=c11 -Wall -Wextra -Wpedantic -O2
CPPFLAGS += -Iinclude
LDLIBS   += -lws2_32

SRC := src/common.c src/buf.c src/str.c src/json.c src/osu_parser.c src/osu_json.c \
       src/http.c src/static.c src/server.c src/main.c
OBJ := $(SRC:src/%.c=build/%.o)
BIN := build/rhythm4k-server.exe

TEST_SRC := tests/test_osu.c
TEST_BIN := build/test-osu.exe
# 测试需要除 main.o 之外的全部目标文件（不要重复定义 main）
LIB_OBJ := $(filter-out build/main.o,$(OBJ))

# 目录创建/删除的写法在两种 shell 下完全不同，这里显式区分。
ifeq ($(OS),Windows_NT)
MKDIR = if not exist "$(1)" mkdir "$(1)"
RMDIR = if exist "$(1)" rmdir /s /q "$(1)"
else
MKDIR = mkdir -p "$(1)"
RMDIR = rm -rf "$(1)"
endif

.PHONY: all clean test run

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) $(OBJ) -o $@ $(LDFLAGS) $(LDLIBS)

build/%.o: src/%.c
	@$(call MKDIR,build)
	$(CC) $(CFLAGS) $(CPPFLAGS) -c $< -o $@

$(TEST_BIN): $(TEST_SRC) $(LIB_OBJ)
	@$(call MKDIR,build)
	$(CC) $(CFLAGS) $(CPPFLAGS) $(TEST_SRC) $(LIB_OBJ) -o $@ $(LDLIBS)

test: $(TEST_BIN)
	@$(TEST_BIN)

run: $(BIN)
	@$(BIN) --root ../dist

clean:
	@$(call RMDIR,build)
