CC = gcc
CFLAGS = -O2 -Wall -Wextra -Wshadow -std=c11
LDFLAGS = -lm

.PHONY: all test clean

all: vibe-fm

vibe-fm: vibe-fm.c
	$(CC) $(CFLAGS) -o $@ vibe-fm.c $(LDFLAGS)

test: vibe-fm
	./vibe-fm self-test

clean:
	rm -f vibe-fm
