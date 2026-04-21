• from __future__ import annotations
                                                                                                                                   
  import os                                                                                                                        
  from urllib.parse import urlencode                                                                                               
                                                                                                                                   
  from hushh_mcp.runtime_settings import get_app_runtime_settings                                                                  

  FRONTEND_ORIGIN_ENV_KEY = "FRONTEND_URL"                                                                                         
  NEXT_PUBLIC_APP_URL_ENV_KEY = "NEXT_PUBLIC_APP_URL"                                                                              
  LOCALHOST_FRONTEND_ORIGIN = "http://localhost:3000"                                                                              
                                                                                                                                   
                                                                                                                                   
  def frontend_origin() -> str:                                                                                                    
      origin = get_app_runtime_settings().app_frontend_origin                                                                      
      if not origin:                                                                                                               
          origin = str(                                                                                                            
              os.getenv(NEXT_PUBLIC_APP_URL_ENV_KEY)                                                                               
              or os.getenv(FRONTEND_ORIGIN_ENV_KEY)                                                                                
              or LOCALHOST_FRONTEND_ORIGIN                                                                                         
          ).strip().rstrip("/")                                                                                                    
      return origin or LOCALHOST_FRONTEND_ORIGIN                                                                                   
                                                                                                                                   
                                                                                                                                   
  def build_consent_request_path(                                                                                                  
      *,                                                                                                                           
      request_id: str | None = None,                                                                                               
      bundle_id: str | None = None,                                                                                                
      view: str = "pending",                                                                                                       
  ) -> str:                                                                                                                        
      params: dict[str, str] = {                                                                                                   
          "tab": "privacy",                                                                                                        
          "sheet": "consents",                                                                                                     
          "consentView": view or "pending",                                                                                        
      }                                                                                                                            
      if request_id:                                                                                                               
          params["requestId"] = request_id                                                                                         
      if bundle_id:                                                                                                                
          params["bundleId"] = bundle_id                                                                                           
      return f"/profile?{urlencode(params)}"                                                                                       
                                                                                                                                   
                                                                                                                                   
  def build_consent_request_url(                                                                                                   
      *,                                                                                                                           
      request_id: str | None = None,                                                                                               
      bundle_id: str | None = None,                                                                                                
      view: str = "pending",                                                                                                       
  ) -> str:                                                                                                                        
      return (                                                                                                                     
          f"{frontend_origin()}"                                                                                                   
          f"{build_consent_request_path(request_id=request_id, bundle_id=bundle_id, view=view)}"                                   
      )                                                                                                                            
      tab: str = "pending",
  ) -> str:
      tab: str = "pending",
  ) -> str:
      return f"{frontend_origin()}{build_connection_request_path(selected=selected, tab=tab)}"
