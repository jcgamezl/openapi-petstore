package org.openapitools.api;

import org.springframework.boot.web.servlet.error.ErrorAttributes;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.server.ResponseStatusException;

import javax.validation.ConstraintViolationException;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Map;

@RestControllerAdvice
public class ExceptionTranslator {

    private final ErrorAttributes errorAttributes;

    public ExceptionTranslator(ErrorAttributes errorAttributes) {
        this.errorAttributes = errorAttributes;
    }

    @ExceptionHandler(ConstraintViolationException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, Object> processConstraintViolationException(WebRequest request) {
        request.setAttribute("javax.servlet.error.status_code", HttpStatus.BAD_REQUEST.value(), RequestAttributes.SCOPE_REQUEST);
        return errorAttributes.getErrorAttributes(request, false);
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> processResponseStatusException(
            ResponseStatusException ex, WebRequest request) {
        HttpStatus status = ex.getStatus();
        Map<String, Object> body = new LinkedHashMap<String, Object>();
        body.put("timestamp", new Date());
        body.put("status", status.value());
        body.put("error", status.getReasonPhrase());
        if (ex.getReason() != null) {
            body.put("message", ex.getReason());
        }
        body.put("path", requestPath(request));
        return ResponseEntity.status(status).body(body);
    }

    private static String requestPath(WebRequest request) {
        String description = request.getDescription(false);
        if (description != null && description.startsWith("uri=")) {
            return description.substring(4);
        }
        return description;
    }
}
