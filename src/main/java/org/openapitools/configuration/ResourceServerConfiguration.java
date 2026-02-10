package org.openapitools.configuration;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.config.annotation.web.configuration.EnableResourceServer;
import org.springframework.security.oauth2.config.annotation.web.configuration.ResourceServerConfigurerAdapter;

/**
 * OAuth2 Resource Server configuration for the OpenAPI Pet Store application.
 * 
 * <p>This configuration class extends {@link ResourceServerConfigurerAdapter} to provide
 * custom security settings for protecting REST API endpoints with OAuth2 authentication.
 * It configures access control for pet-related endpoints and enforces specific OAuth2 scopes.</p>
 * 
 * <p>The configuration applies to the following endpoints:</p>
 * <ul>
 *   <li>GET /v3/pet - Retrieve pet information</li>
 *   <li>GET /v3/pet/findByStatus - Find pets by status</li>
 *   <li>POST /v3/pet/** - Create or update pet resources</li>
 * </ul>
 * 
 * <p>Required OAuth2 scopes: 'write:pets' AND 'read:pets'</p>
 * 
 * @author OpenAPI Tools
 * @version 1.0
 * @since 1.0
 */
@Configuration
@EnableResourceServer
public class ResourceServerConfiguration extends ResourceServerConfigurerAdapter {

    /**
     * Base path for the OpenAPI Pet Store API endpoints.
     * 
     * <p>This value is injected from application properties with a default fallback
     * to "/v3" if not specified in the configuration.</p>
     * 
     * @see org.springframework.beans.factory.annotation.Value
     */
    @Value("${openapi.openAPIPetstore.base-path:/v3}")
    private String apiBasePath;

    /**
     * Configures HTTP security settings for the OAuth2 resource server.
     * 
     * <p>This method sets up the security configuration for specific API endpoints,
     * implementing stateless session management and OAuth2 scope-based authorization.
     * The configuration ensures that only authenticated requests with proper OAuth2
     * scopes can access the protected pet-related endpoints.</p>
     * 
     * <p>Security configuration includes:</p>
     * <ul>
     *   <li>Request matchers for pet endpoints</li>
     *   <li>Stateless session management (no server-side sessions)</li>
     *   <li>OAuth2 scope validation requiring both 'write:pets' and 'read:pets'</li>
     * </ul>
     * 
     * <p>Protected endpoints:</p>
     * <ul>
     *   <li>{@code GET {apiBasePath}/pet} - Requires read and write pets scopes</li>
     *   <li>{@code GET {apiBasePath}/pet/findByStatus} - Requires read and write pets scopes</li>
     *   <li>{@code POST {apiBasePath}/pet/**} - Requires read and write pets scopes</li>
     * </ul>
     * 
     * @param http the {@link HttpSecurity} object to configure
     * @throws Exception if an error occurs during security configuration
     * 
     * @see HttpSecurity#requestMatchers()
     * @see HttpSecurity#sessionManagement()
     * @see HttpSecurity#authorizeRequests()
     * @see SessionCreationPolicy#STATELESS
     */
    @Override
    public void configure(HttpSecurity http) throws Exception {
        http.requestMatchers()
                // Configure request matchers for pet-related endpoints
                .antMatchers(apiBasePath + "/pet")
                .antMatchers(apiBasePath + "/pet/findByStatus")
                .antMatchers(HttpMethod.POST, apiBasePath + "/pet/**")
                .and()
                // Configure stateless session management for REST API
                .sessionManagement().sessionCreationPolicy(SessionCreationPolicy.STATELESS)
                .and()
                // Configure authorization requirements with OAuth2 scope validation
                .authorizeRequests()
                .anyRequest().access("#oauth2.hasScope('write:pets') and #oauth2.hasScope('read:pets')");
    }
}