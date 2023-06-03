.PHONY: sync format lint typecheck test check build clean run

sync:
	cmake -S . -B build -DCMAKE_BUILD_TYPE=Release

format:
	find core -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.cu' -o -name '*.cuh' \) -print0 | xargs -0 clang-format -i

lint:
	find core/src -type f \( -name '*.cpp' -o -name '*.h' \) -print0 | xargs -0 clang-tidy -p build --quiet

typecheck:
	cmake --build build --target simulator

test:
	cmake --build build
	ctest --test-dir build --output-on-failure

check: format lint typecheck test

build:
	cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
	cmake --build build

clean:
	rm -rf build

run: build
	./build/simulator core/config.toml
