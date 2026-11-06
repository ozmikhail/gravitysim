.PHONY: sync plumb fix typecheck test check build clean run hooks

PLUMB := node tools/plumb/bin/plumb.mjs

sync:
	cmake -S . -B build -DCMAKE_BUILD_TYPE=Release

build/compile_commands.json: CMakeLists.txt core/CMakeLists.txt
	cmake -S . -B build -DCMAKE_BUILD_TYPE=Release

plumb: build/compile_commands.json
	$(PLUMB) check

fix: build/compile_commands.json
	$(PLUMB) fix

typecheck:
	cmake --build build --target simulator

test:
	cmake --build build
	ctest --test-dir build --output-on-failure

check: plumb typecheck test

build:
	cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
	cmake --build build

clean:
	rm -rf build

run: build
	./build/simulator core/config.toml

hooks:
	git config core.hooksPath .githooks
