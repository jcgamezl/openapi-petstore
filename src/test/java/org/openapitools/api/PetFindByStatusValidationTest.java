package org.openapitools.api;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.junit4.SpringRunner;
import org.springframework.test.web.servlet.MockMvc;

import static org.hamcrest.Matchers.allOf;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@RunWith(SpringRunner.class)
@SpringBootTest
@AutoConfigureMockMvc(addFilters = false)
public class PetFindByStatusValidationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    public void available_returns200Array() throws Exception {
        mockMvc.perform(get("/v3/pet/findByStatus")
                        .accept(MediaType.APPLICATION_JSON)
                        .param("status", "available"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isArray());
    }

    @Test
    public void invalidStatus_returns400WithAllowedValuesInMessage() throws Exception {
        mockMvc.perform(get("/v3/pet/findByStatus")
                        .accept(MediaType.APPLICATION_JSON)
                        .param("status", "foo"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message", allOf(
                        containsString("available"),
                        containsString("pending"),
                        containsString("sold"))))
                .andExpect(jsonPath("$.path", containsString("/pet/findByStatus")))
                .andExpect(jsonPath("$.trace").doesNotExist())
                .andExpect(jsonPath("$.exception").doesNotExist());
    }

    @Test
    public void mixedList_returns400ForWholeRequest() throws Exception {
        mockMvc.perform(get("/v3/pet/findByStatus")
                        .accept(MediaType.APPLICATION_JSON)
                        .param("status", "available,foo"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message", allOf(
                        containsString("available"),
                        containsString("pending"),
                        containsString("sold"))));
    }

    @Test
    public void availableAndPending_returns200Array() throws Exception {
        mockMvc.perform(get("/v3/pet/findByStatus")
                        .accept(MediaType.APPLICATION_JSON)
                        .param("status", "available,pending"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isArray());
    }

    @Test
    public void statusTokensWithSpaces_areTrimmedAndReturn200() throws Exception {
        mockMvc.perform(get("/v3/pet/findByStatus")
                        .accept(MediaType.APPLICATION_JSON)
                        .param("status", "available, pending"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isArray());
    }

    @Test
    public void emptyStatusToken_returns400() throws Exception {
        mockMvc.perform(get("/v3/pet/findByStatus")
                        .accept(MediaType.APPLICATION_JSON)
                        .param("status", "available,"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message", containsString("available")));
    }
}
