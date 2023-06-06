#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

class AppError : public std::runtime_error {
public:
    enum class Retry : std::uint8_t { No = 0, Yes = 1 };

    AppError(std::string_view kind, std::string_view message, Retry retry = Retry::No);

    [[nodiscard]] std::string_view kind() const noexcept { return kind_; }
    [[nodiscard]] bool retryable() const noexcept { return retry_ == Retry::Yes; }

    static AppError invalid_input(std::string_view message);
    static AppError missing(std::string_view message);
    static AppError state_conflict(std::string_view message);
    static AppError dependency_unavailable(std::string_view message);
    static AppError unauthorized(std::string_view message);
    static AppError not_found(std::string_view message);
    static AppError conflict(std::string_view message);
    static AppError timeout(std::string_view message);
    static AppError unimplemented(std::string_view message);
    static AppError access_denied(std::string_view message);

private:
    std::string kind_;
    Retry retry_;
};
